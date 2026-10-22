import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import {
  waitForHostedMaintenance,
  type HostedMaintenanceSnapshot,
} from "./updateEverythingMaintenance";

function machine(
  status: "running" | "queued" | "succeeded",
  hostedByThisApp = true,
): HostedMaintenanceSnapshot["machines"][number] {
  return {
    hostedByThisApp,
    connected: true,
    sessionReady: true,
    providers: [
      { updateState: { status, startedAt: null, finishedAt: null, message: null, output: null } },
    ],
  };
}

it("waits for all hosted provider work, including WSL work queued while the first install finishes", async () => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedMaintenanceSnapshot>({
      ready: true,
      machines: [machine("running"), machine("succeeded"), machine("running", false)],
    });
    const calls: string[] = [];
    const admitted = waitForHostedMaintenance(registry, source).then(() => {
      calls.push("install");
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      machines: [machine("succeeded"), machine("queued"), machine("running", false)],
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      machines: [machine("succeeded"), machine("running"), machine("running", false)],
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      machines: [machine("succeeded"), machine("succeeded"), machine("running", false)],
    });
    await admitted;
    expect(calls).toEqual(["install"]);
  } finally {
    registry.dispose();
  }
});

it("checks maintenance that starts while a plain restart is being prepared", async () => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedMaintenanceSnapshot>({
      ready: true,
      machines: [machine("succeeded")],
    });
    let finishPreparation!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const calls: string[] = [];
    const restart = (async () => {
      await prepared;
      await waitForHostedMaintenance(registry, source);
      calls.push("install");
    })();
    registry.set(source, { ready: true, machines: [machine("queued")] });
    finishPreparation();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, { ready: true, machines: [machine("succeeded")] });
    await restart;
    expect(calls).toEqual(["install"]);
  } finally {
    registry.dispose();
  }
});

it("refuses install if a hosted connection loses readiness during maintenance", async () => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedMaintenanceSnapshot>({
      ready: true,
      machines: [machine("running")],
    });
    const admitted = waitForHostedMaintenance(registry, source);
    const refused = expect(admitted).rejects.toThrow("A local connection is not ready");
    registry.set(source, { ready: true, machines: [{ ...machine("running"), connected: false }] });
    await refused;
  } finally {
    registry.dispose();
  }
});
