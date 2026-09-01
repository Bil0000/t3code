// @effect-diagnostics nodeBuiltinImport:off -- Isolated D-Bus integration fixture, never the user's session bus.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { Message, NameFlag, Variant, sessionBus, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
    }),
  },
}));
import { LinuxCaptureConnection } from "./LinuxWindowCapture.ts";

const hasDbus = NodeChildProcess.spawnSync("dbus-daemon", ["--version"]).status === 0;

it.runIf(hasDbus)("captures through real D-Bus marshalling on a private bus", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-private-dbus-"));
  let daemon: NodeChildProcess.ChildProcess | undefined;
  let server: MessageBus | undefined;
  const clients: LinuxCaptureConnection[] = [];
  try {
    daemon = NodeChildProcess.spawn(
      "dbus-daemon",
      [
        "--session",
        "--nofork",
        "--nopidfile",
        "--print-address",
        `--address=unix:path=${NodePath.join(directory, "bus")}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const lines = NodeReadline.createInterface({ input: daemon.stdout! });
    const [address] = await Promise.race([
      NodeEvents.EventEmitter.once(lines, "line"),
      NodeEvents.EventEmitter.once(daemon, "exit").then(() => {
        throw new Error("Private D-Bus daemon failed to start.");
      }),
    ]);
    lines.close();
    server = sessionBus({ busAddress: String(address) });
    server.on("error", () => undefined);
    await server.requestName("org.freedesktop.portal.Desktop", NameFlag.DO_NOT_QUEUE);
    await server.requestName("org.gnome.Shell.Extensions.T3WindowCapture", NameFlag.DO_NOT_QUEUE);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const imagePath = NodePath.join(directory, "image.png");
    await NodeFSP.writeFile(imagePath, png);
    let portalVersion = 3;
    let extensionVersion = 1;
    let feedbackArgs: unknown[] | undefined;
    let activateTitle: unknown;
    let animateFrame: unknown[] | undefined;
    let target: unknown;
    let clientName: string | undefined;
    server.addMethodHandler((message: Message) => {
      if (message.member === "Register") {
        server!.send(Message.newMethodReturn(message));
      } else if (message.member === "GetAll") {
        const properties =
          message.body[0] === "org.freedesktop.portal.Screenshot"
            ? { version: new Variant("u", portalVersion), AvailableTargets: new Variant("u", 8) }
            : { Version: new Variant("u", extensionVersion) };
        server!.send(Message.newMethodReturn(message, "a{sv}", [properties]));
      } else if (message.member === "Screenshot") {
        const options = message.body[1] as Record<string, Variant<unknown>>;
        target = options.target?.value;
        const path = `/org/freedesktop/portal/desktop/request/${message.sender.slice(1).replaceAll(".", "_")}/${options.handle_token?.value}`;
        // The real transport also has to handle Response before the method reply.
        const signal = Message.newSignal(
          path,
          "org.freedesktop.portal.Request",
          "Response",
          "ua{sv}",
          [0, { uri: new Variant("s", NodeURL.pathToFileURL(imagePath).href) }],
        );
        signal.destination = message.sender;
        server!.send(signal);
        server!.send(Message.newMethodReturn(message, "o", [path]));
      } else if (message.member === "Activate") {
        activateTitle = message.body[0];
        server!.send(Message.newMethodReturn(message));
      } else if (message.member === "Animate") {
        animateFrame = message.body;
        server!.send(Message.newMethodReturn(message));
      } else if (message.member === "Capture" || message.member === "CaptureWithFeedback") {
        const feedback = message.member === "CaptureWithFeedback";
        if (feedback) feedbackArgs = message.body;
        clientName = message.sender;
        server!.send(
          Message.newMethodReturn(message, feedback ? "aysb" : "ays", [
            png,
            JSON.stringify({
              title: "Editor",
              appName: "Editor",
              appIdentifier: "editor.desktop",
              processId: 42,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
            }),
            ...(feedback ? [true] : []),
          ]),
        );
      } else return false;
      return true;
    });
    const connect = () => {
      const client = new LinuxCaptureConnection(sessionBus({ busAddress: String(address) }));
      clients.push(client);
      return client;
    };
    const portal = connect();
    expect(await portal.backend("com.t3tools.T3Code")).toBe("screenshot-portal");
    expect(await portal.capturePortal()).toEqual({ png });
    expect(target).toBe(8);
    portalVersion = 2;
    const extension = connect();
    expect(await extension.backend("com.t3tools.T3Code")).toBe("gnome-extension");
    expect(await extension.captureExtension("com.t3tools.T3Code")).toMatchObject({
      png,
      window: { processId: 42 },
    });
    const owner = await server.call(
      new Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "GetNameOwner",
        signature: "s",
        body: ["com.t3tools.T3Code.WindowCapture"],
      }),
    );
    expect(owner?.body[0]).toBe(clientName);
    extension.close();
    extensionVersion = 2;
    const updated = connect();
    expect(await updated.backend("com.t3tools.T3Code")).toBe("gnome-extension");
    const snapshot = await updated.captureExtension("com.t3tools.T3Code", {
      flash: true,
      animate: true,
    });
    expect(snapshot.feedback?.animationStarted).toBe(true);
    await snapshot.feedback!.activate("T3 Code");
    await snapshot.feedback!.animateTo({ x: 0.1, y: 0.8, width: 0.2, height: 0.1 });
    await snapshot.feedback!.complete();
    expect(feedbackArgs).toEqual([true, true]);
    expect(activateTitle).toBe("T3 Code");
    expect(animateFrame).toEqual([0.1, 0.8, 0.2, 0.1]);
  } finally {
    for (const client of clients) client.close();
    server?.disconnect();
    if (daemon && daemon.exitCode === null) {
      const exited = NodeEvents.EventEmitter.once(daemon, "exit");
      daemon.kill("SIGTERM");
      await exited;
    }
    await NodeFSP.rm(directory, { recursive: true });
  }
});
