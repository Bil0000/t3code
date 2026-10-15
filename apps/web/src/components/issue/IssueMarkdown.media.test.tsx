// @vitest-environment jsdom

import type {
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import {
  AssetWorkspaceContextNotFoundError,
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type AssetResource,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const assets = vi.hoisted(() => ({
  calls: [] as Array<{ environmentId: string; resource: AssetResource }>,
  fail: new Set<string>(),
  signatures: 0,
}));

vi.mock("../../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const StreamModule = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const services = await import("@t3tools/client-runtime/connection");
  const supervisors = new Map<string, EnvironmentSupervisor.EnvironmentSupervisor["Service"]>();
  const supervisor = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    const existing = supervisors.get(environmentId);
    if (existing) return existing;
    const client = {
      [WS_METHODS.assetsCreateUrl]: ({ resource }: { resource: AssetResource }) =>
        Effect.suspend(() => {
          assets.calls.push({ environmentId, resource });
          if (assets.fail.has(environmentId))
            return Effect.fail(new AssetWorkspaceContextNotFoundError({ resource }));
          assets.signatures += 1;
          return Effect.succeed({
            relativeUrl: `/api/assets/${environmentId}/signed-${assets.signatures}`,
            expiresAt: 1,
          });
        }),
    };
    const service = {
      target: { environmentId },
      state: yield* SubscriptionRef.make({ phase: "connected" }),
      session: yield* SubscriptionRef.make(Option.some({ client })),
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    supervisors.set(environmentId, service);
    return service;
  });
  const provide = <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(supervisor(environmentId), (service) =>
      Effect.provideService(effect, services.EnvironmentSupervisor.EnvironmentSupervisor, service),
    );
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.succeed(
        services.EnvironmentRegistry.EnvironmentRegistry,
        services.EnvironmentRegistry.EnvironmentRegistry.of({
          run: provide,
          followStream: <A, E, R>(environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
            StreamModule.provideServiceEffect(
              stream,
              services.EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(environmentId),
            ),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    ),
  };
});
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  usePreparedConnection: (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? { _tag: "None" }
      : { _tag: "Some", value: { httpBaseUrl: `https://${environmentId}.test/` } },
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/state/issues", async () => {
  const { Atom } = await import("effect/reactivity");
  return { issueEnvironment: { editComment: { permissionAtom: () => Atom.make(false) } } };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../media/MediaActions", () => ({
  MediaActions: ({ children }: { children: unknown }) => children,
}));

import { IssueCommentContent } from "./IssueConversation";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";

const upload =
  "https://uploads.linear.app/11111111-1111-4111-8111-111111111111/22222222/screenshot.png";
const text = `Before\n\n![Screenshot](${upload})`;
const environmentA = EnvironmentId.make("env-a");
const environmentB = EnvironmentId.make("env-b");
const threadRef = { environmentId: environmentA, threadId: ThreadId.make("thread-a") };
const issue = {
  projectId: ProjectId.make("project-b"),
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "workspace/ENG",
  key: "ENG-7",
  connectionId: "Account/B",
};
let container: HTMLDivElement;
let root: Root;
let registry: AtomRegistry.AtomRegistry;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  assets.calls.length = 0;
  assets.fail.clear();
  assets.signatures = 0;
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}
async function render(node: React.ReactNode) {
  await act(async () => root.render(<RegistryContext value={registry}>{node}</RegistryContext>));
  await flush();
}
const sources = () => [...container.querySelectorAll("img")].map((image) => image.src);
const linearResource = { _tag: "linear-media", issue, url: upload };
const { connectionId: _defaultAccount, ...defaultIssue } = issue;

it.each([
  ["Account/B beside thread A", threadRef, issue],
  ["default account beside thread A", threadRef, defaultIssue],
  ["standalone Account/B", null, issue],
] as const)(
  "signs an issue body image at the issue's environment and account (%s)",
  async (_name, owner, reference) => {
    await render(
      <PullRequestCommentBody
        text={text}
        cwd="/repo"
        environmentId={environmentB}
        threadRef={owner}
        issueLinkContext={{ ...reference, environmentId: environmentB }}
      />,
    );
    expect(assets.calls).toEqual([
      {
        environmentId: environmentB,
        resource: { ...linearResource, issue: reference },
      },
    ]);
    expect(sources()).toEqual(["https://env-b.test/api/assets/env-b/signed-1"]);
    expect(container.innerHTML).not.toContain(`src="${upload}"`);
  },
);

it("keeps the raw upload in the editor and signs only its preview", async () => {
  const onSave = vi.fn();
  await render(
    <PullRequestMarkdownEditor
      value={text}
      cwd="/repo"
      environmentId={environmentB}
      threadRef={threadRef}
      issueLinkContext={{ ...issue, environmentId: environmentB }}
      label="Edit comment"
      saving={false}
      onSave={onSave}
      onCancel={vi.fn()}
    />,
  );
  expect(container.querySelector("textarea")?.value).toBe(text);
  expect(assets.calls).toEqual([]);
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Preview")!
      .click(),
  );
  await flush();
  expect(assets.calls).toEqual([{ environmentId: environmentB, resource: linearResource }]);
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Save")!
      .click(),
  );
  expect(onSave).toHaveBeenCalledExactlyOnceWith(text);
});

it("shows the failure state on an old server instead of loading the private URL", async () => {
  assets.fail.add(environmentB);
  await render(
    <PullRequestCommentBody
      text={text}
      cwd="/repo"
      environmentId={environmentB}
      threadRef={threadRef}
      issueLinkContext={{ ...issue, environmentId: environmentB }}
    />,
  );
  expect(assets.calls).toHaveLength(1);
  expect(sources()).toEqual([]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Image unavailable");
  expect(container.innerHTML).not.toContain(`src="${upload}"`);
});

it.each([
  ["a GitHub issue", { tracker: IssueTrackerKind.make("github"), host: "github.com" }, upload],
  ["a foreign host", {}, "https://uploads.linear.app.evil.test/a/b/screenshot.png"],
  ["a non-default port", {}, "https://uploads.linear.app:8443/a/b/screenshot.png"],
  ["userinfo", {}, "https://user@uploads.linear.app/a/b/screenshot.png"],
  ["plain HTTP", {}, "http://uploads.linear.app/a/b/screenshot.png"],
  ["public media", {}, "https://example.com/screenshot.png"],
] as const)("leaves %s loading directly", async (_name, overrides, url) => {
  await render(
    <PullRequestCommentBody
      text={`![Screenshot](${url})`}
      cwd="/repo"
      environmentId={environmentB}
      issueLinkContext={{ ...issue, ...overrides, environmentId: environmentB }}
    />,
  );
  expect(assets.calls).toEqual([]);
  expect(sources()).toEqual([new URL(url).href]);
});

it("does not infer a Linear account from the URL alone", async () => {
  await render(<PullRequestCommentBody text={text} cwd="/repo" environmentId={environmentB} />);
  expect(assets.calls).toEqual([]);
  expect(sources()).toEqual([upload]);
});

it("signs a comment image and re-signs it on the existing asset refresh interval", async () => {
  vi.useFakeTimers();
  try {
    await render(
      <IssueCommentContent
        environmentId={environmentB}
        reference={issue}
        threadRef={threadRef}
        cwd="/repo"
        canEdit={false}
        comment={{
          id: "comment",
          body: text,
          author: null,
          createdAt: "2026-10-14T00:00:00Z",
          url: null,
          canEdit: false,
        }}
      />,
    );
    expect(assets.calls).toEqual([{ environmentId: environmentB, resource: linearResource }]);
    expect(sources()).toEqual(["https://env-b.test/api/assets/env-b/signed-1"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(assets.calls).toHaveLength(2);
    expect(assets.calls[1]).toEqual({ environmentId: environmentB, resource: linearResource });
    expect(sources()).toEqual(["https://env-b.test/api/assets/env-b/signed-2"]);
  } finally {
    vi.useRealTimers();
  }
});

it("retries a failed Linear video through the signed resource only", async () => {
  const video = upload.replace("screenshot.png", "recording.mp4");
  assets.fail.add(environmentB);
  await render(
    <PullRequestCommentBody
      text={video}
      cwd="/repo"
      environmentId={environmentB}
      issueLinkContext={{ ...issue, environmentId: environmentB }}
    />,
  );
  expect(container.querySelector("video")).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");
  assets.fail.clear();
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Retry video"))!
      .click(),
  );
  await flush();
  expect(assets.calls.map((call) => call.resource)).toEqual([
    { ...linearResource, url: video },
    { ...linearResource, url: video },
  ]);
  expect(container.querySelector("video")?.src).toBe(
    "https://env-b.test/api/assets/env-b/signed-1",
  );
});
