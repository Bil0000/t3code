import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  type AuthSessionState,
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "@effect/vitest";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcClient from "../rpc/client.ts";
import * as Session from "./session.ts";
import { createIssueEnvironmentAtoms } from "./issues.ts";
import { executeAtomQuery } from "./runtime.ts";

it.effect.each([
  "github-state",
  "gitlab-state",
  "title",
  "labels",
  "assignees",
  "parent",
  "switch-parent",
  "unlink-parent",
  "child",
  "unlinked-child",
  "comment",
  "edit-comment",
  "reaction",
  "failed-state",
  "manual",
  "alias",
  "hostless",
  "create",
])("refreshes only affected mounted first history pages after %s", (kind) =>
  Effect.gen(function* () {
    const supervisor = {
      state: yield* SubscriptionRef.make({ phase: "connected" }),
      session: yield* SubscriptionRef.make(Option.some({})),
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    yield* Effect.promise(async () => {
      const environment = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environment),
      );
      const session: AuthSessionState = {
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
        permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
      };
      const sessions = vi.spyOn(Session, "createEnvironmentSessionAtoms").mockReturnValue({
        sessionStateAtom: () => Atom.make(AsyncResult.success(session)),
      } as unknown as ReturnType<typeof Session.createEnvironmentSessionAtoms>);
      let written = false;
      const reads: Array<{ key: string; cursor?: string; limit?: number }> = [];
      const read = vi.spyOn(RpcClient, "request");
      read.mockImplementation(((
        tag: string,
        input: { key: string; cursor?: string; limit?: number },
      ) =>
        Effect.sync(() => {
          if (tag === WS_METHODS.issuesHistory) reads.push(input);
          if (tag === WS_METHODS.issuesHierarchy)
            return {
              parent: {
                scope: "org/repo",
                key: "old-parent",
                displayKey: "#old-parent",
                title: "Parent",
                url: "https://github.com/org/repo/issues/2",
                state: { category: "open", name: "open" },
              },
              children: { items: [], nextCursor: null },
            };
          return {
            items: written
              ? [
                  {
                    id: "closed",
                    kind: "closed",
                    actor: null,
                    createdAt: "2026-10-15T00:00:00Z",
                    detail: null,
                  },
                ]
              : [],
            nextCursor: null,
          };
        })) as unknown as Parameters<typeof read.mockImplementation>[0]);
      const write = vi.spyOn(RpcClient, "requestGuarded");
      write.mockImplementation((() =>
        kind === "failed-state"
          ? Effect.fail("Denied")
          : Effect.sync(() => {
              written = true;
              return {
                key: "child",
                displayKey: "#child",
                url: "https://github.com/org/repo/issues/2",
                parentLinked: kind !== "unlinked-child",
              };
            })) as unknown as Parameters<typeof write.mockImplementation>[0]);
      const atoms = createIssueEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      const environmentId = EnvironmentId.make("environment");
      const reference = {
        projectId: ProjectId.make("project"),
        tracker: IssueTrackerKind.make(kind === "gitlab-state" ? "gitlab" : "github"),
        host: kind === "hostless" ? undefined : "native.example",
        scope: "org/repo",
        key: "1",
      };
      const targets = [
        { environmentId, input: reference },
        { environmentId, input: { ...reference, key: "parent" } },
        { environmentId, input: { ...reference, host: "other.example" } },
        { environmentId, input: { ...reference, tracker: IssueTrackerKind.make("forgejo") } },
        { environmentId: EnvironmentId.make("other-environment"), input: reference },
        { environmentId, input: { ...reference, cursor: "tail" } },
        { environmentId, input: { ...reference, key: "old-parent" } },
        ...(kind === "hostless"
          ? [{ environmentId, input: { ...reference, projectId: ProjectId.make("other-project") } }]
          : []),
      ];
      const queries = targets.map((target) => atoms.history(target));
      const releases = queries.map((query) => registry.mount(query));
      const idle = atoms.history({ environmentId, input: { ...reference, limit: 1 } });
      const releaseIdle = registry.mount(idle);
      const heldHierarchy = atoms.hierarchy({ environmentId, input: reference });
      const oldParentKnown = kind === "switch-parent" || kind === "unlink-parent";
      const releaseHierarchy = oldParentKnown ? registry.mount(heldHierarchy) : () => undefined;
      try {
        await Promise.all([...queries, idle].map((query) => executeAtomQuery(registry, query)));
        if (oldParentKnown) await executeAtomQuery(registry, heldHierarchy);
        releaseIdle();
        const before = reads.length;
        const target = {
          environmentId,
          input:
            kind === "alias"
              ? {
                  ...reference,
                  projectId: ProjectId.make("alias"),
                  host: "NATIVE.EXAMPLE",
                  scope: "ORG/REPO",
                }
              : reference,
        };
        if (kind === "manual") {
          written = true;
          registry.update(atoms.historyRefresh(target), (value) => value + 1);
        } else {
          const result = await (() => {
            switch (kind) {
              case "title":
              case "labels":
              case "assignees":
                return atoms.update.run(registry, {
                  ...target,
                  input: {
                    ...reference,
                    ...(kind === "title"
                      ? { title: "Changed" }
                      : kind === "labels"
                        ? { labels: ["bug"] }
                        : { assignees: ["octo"] }),
                  },
                });
              case "parent":
              case "switch-parent":
              case "unlink-parent":
                return atoms.setParent.run(registry, {
                  ...target,
                  input: { ...reference, parentKey: kind === "unlink-parent" ? null : "parent" },
                });
              case "child":
              case "unlinked-child":
              case "create":
                return atoms.create.run(registry, {
                  environmentId,
                  input: {
                    ...reference,
                    title: "Child",
                    body: "",
                    labels: [],
                    assignees: [],
                    ...(kind === "create" ? {} : { parentKey: reference.key }),
                  },
                });
              case "comment":
                return atoms.comment.run(registry, {
                  ...target,
                  input: { ...reference, body: "Comment" },
                });
              case "edit-comment":
                return atoms.editComment.run(registry, {
                  ...target,
                  input: { ...reference, commentId: "comment", body: "Edited" },
                });
              case "reaction":
                return atoms.react.run(registry, {
                  ...target,
                  input: { ...reference, content: "thumbs-up", reacted: true },
                });
              default:
                return atoms.setState.run(registry, {
                  ...target,
                  input: { ...target.input, state: "closed" },
                });
            }
          })();
          expect(result._tag).toBe(kind === "failed-state" ? "Failure" : "Success");
        }
        const changed = !["reaction", "failed-state", "unlinked-child", "create"].includes(kind);
        const current = await executeAtomQuery(registry, queries[0]!);
        expect(current).toMatchObject({
          _tag: "Success",
          value: { items: changed ? [expect.objectContaining({ kind: "closed" })] : [] },
        });
        const changedKeys = changed
          ? [
              "1",
              ...(kind === "parent" || kind === "switch-parent" ? ["parent"] : []),
              ...(oldParentKnown ? ["old-parent"] : []),
            ]
          : [];
        for (const [index, query] of queries.entries()) {
          if (index === 0) continue;
          if ((index === 1 && changedKeys.includes("parent")) || (index === 6 && oldParentKnown))
            expect(await executeAtomQuery(registry, query)).toMatchObject({
              _tag: "Success",
              value: { items: [expect.objectContaining({ kind: "closed" })] },
            });
          else expect(registry.get(query)).toMatchObject({ value: { items: [] } });
        }
        expect(reads.slice(before).map((input) => input.key)).toEqual(changedKeys);
        expect(read.mock.calls.filter(([tag]) => tag === WS_METHODS.issuesHierarchy)).toHaveLength(
          oldParentKnown ? 2 : 0,
        );
        if (changed) {
          expect(await executeAtomQuery(registry, idle)).toMatchObject({
            _tag: "Success",
            value: { items: [expect.objectContaining({ kind: "closed" })] },
          });
          expect(reads.at(-1)).toMatchObject({ key: "1", limit: 1 });
          expect(reads.length - before).toBe(changedKeys.length + 1);
        }
      } finally {
        releases.forEach((release) => release());
        releaseHierarchy();
        registry.dispose();
        read.mockRestore();
        write.mockRestore();
        sessions.mockRestore();
      }
    });
  }),
);
