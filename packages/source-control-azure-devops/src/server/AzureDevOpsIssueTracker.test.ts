import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";
import {
  decodeWorkItemJson,
  decodeWorkItemsJson,
  pullRequestNumberOf,
} from "./azureDevOpsIssueJson.ts";

const encode = (value: unknown) => JSON.stringify(value);

const WORK_ITEM = {
  id: 7,
  url: "https://dev.azure.com/acme/_apis/wit/workItems/7",
  fields: {
    "System.Title": "Composer loses focus",
    "System.State": "Resolved",
    "System.CreatedDate": "2026-07-01T00:00:00Z",
    "System.ChangedDate": "2026-07-03T00:00:00Z",
    "Microsoft.VSTS.Common.ClosedDate": "2026-07-03T00:00:00Z",
    "System.CreatedBy": { uniqueName: "octo@acme.test", displayName: "Octo Cat" },
    "System.AssignedTo": "Theo <theo@acme.test>",
    "System.Tags": "bug; ui; bug",
    "System.TeamProject": "Web App",
    "System.CommentCount": 2,
    "System.Description": "<p>Typing drops focus.</p>",
  },
  relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F50" },
    { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/acme/_apis/wit/workItems/8" },
  ],
};

/** Every `az` command the detail read runs, told apart by its first few arguments. */
function answer(args: ReadonlyArray<string>): string {
  const resource = args[args.indexOf("--resource") + 1];
  if (args[0] === "boards") return encode(WORK_ITEM);
  if (args[0] === "repos") {
    return encode({
      pullRequestId: 50,
      title: "fix(web): keep composer focus",
      status: "completed",
      isDraft: false,
      sourceRefName: "refs/heads/fix",
      targetRefName: "refs/heads/main",
      creationDate: "2026-07-02T00:00:00Z",
      closedDate: "2026-07-03T00:00:00Z",
      mergeStatus: "succeeded",
      repository: {
        id: "r-guid",
        name: "web",
        webUrl: "https://dev.azure.com/acme/Web%20App/_git/web",
        project: { id: "p-guid", name: "Web App" },
      },
      createdBy: { uniqueName: "theo@acme.test", displayName: "Theo" },
      description: "",
      reviewers: [],
      _links: { web: { href: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50" } },
    });
  }
  if (resource === "comments") {
    return encode({
      continuationToken: "next-token",
      comments: [
        {
          id: 1,
          text: "Repro attached.",
          createdDate: "2026-07-02T00:00:00Z",
          createdBy: { uniqueName: "julius@acme.test", displayName: "Julius" },
          reactions: [
            { type: "like", count: 2, isCurrentUserEngaged: true },
            { type: "dislike", count: 0 },
          ],
        },
        { id: 2, text: "gone", createdDate: "2026-07-02T00:00:00Z", isDeleted: true },
      ],
    });
  }
  if (resource === "updates") {
    return encode({
      value: [
        {
          id: 1,
          revisedDate: "2026-07-01T00:00:00Z",
          fields: { "System.Title": { newValue: "x" } },
        },
        {
          id: 2,
          revisedDate: "9999-01-01T00:00:00Z",
          revisedBy: { uniqueName: "theo@acme.test" },
          fields: {
            "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
            "System.State": { oldValue: "Active", newValue: "Resolved" },
            "System.Tags": { oldValue: "ui", newValue: "bug; ui" },
          },
        },
      ],
    });
  }
  throw new Error(`unexpected az invocation ${args.join(" ")}`);
}

function tracker(onExecute: (args: ReadonlyArray<string>) => string) {
  return AzureDevOpsIssueTracker.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          execute: ({ args }) =>
            Effect.succeed(TestSourceControlHost.processOutput(onExecute(args))),
        }),
      ),
    ),
  );
}

describe("AzureDevOpsIssueTracker", () => {
  it.effect.each([true, false])(
    "reads candidates in four calls and labels in one with inline states %s",
    (inline) =>
      Effect.gen(function* () {
        let calls = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          if (args[1] === "project")
            return encode({ id: "project", name: "Web App", defaultTeam: { id: "team" } });
          if (args[1] === "team") return encode([]);
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "tags") return encode({ value: [{ name: "bug" }] });
          if (resource === "workitemtypes")
            return encode({
              value: Array.from({ length: 100 }, (_, index) => ({
                name: `Type ${index}`,
                ...(inline
                  ? { states: [{ name: `Review ${index}`, category: "InProgress" }] }
                  : {}),
              })),
            });
          throw new Error(`Unexpected ${resource}`);
        });
        const scope = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App" };
        const candidates = yield* api.listCandidates!(scope);
        expect(candidates.states).toHaveLength(inline ? 100 : 0);
        if (inline)
          expect(candidates.states?.[99]).toMatchObject({
            name: "Review 99",
            workflowCategory: "started",
          });
        expect(candidates.truncated).toBe(!inline);
        expect(calls).toBe(4);
        calls = 0;
        expect((yield* api.listLabelCandidates!(scope)).items).toMatchObject([{ name: "bug" }]);
        expect(calls).toBe(1);
      }),
  );

  it.effect(
    "keeps custom states scoped to the current detail with one workflow call and no viewer read",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        let workflowReads = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          if (args[0] === "boards")
            return encode({
              ...WORK_ITEM,
              relations: [],
              fields: {
                ...WORK_ITEM.fields,
                "System.WorkItemType": "Bug",
                "System.State": "Review",
              },
            });
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "workitemtypestates") {
            workflowReads += 1;
            expect(args).toContain("type=Bug");
            return encode({
              value: [
                { name: "Review", category: "InProgress" },
                { name: "Shipped", category: "Completed" },
              ],
            });
          }
          return answer(args);
        });
        const detail = yield* api.getIssue({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
        });
        expect(detail.state).toMatchObject({
          name: "Review",
          id: "Review",
          workflowCategory: "started",
        });
        expect(detail.states?.map((state) => state.name)).toEqual(["Review", "Shipped"]);
        expect(detail.viewer).toBeNull();
        expect(workflowReads).toBe(1);
        expect(calls).toBe(4);
      }),
  );

  it.effect("bounds cross-project hierarchy reads and keeps the next raw relation page", () =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* tracker((args) => {
        calls += 1;
        if (args[0] === "boards")
          return encode({
            ...WORK_ITEM,
            relations: [
              {
                rel: "System.LinkTypes.Hierarchy-Reverse",
                url: "https://dev.azure.com/acme/_apis/wit/workItems/4",
              },
              ...Array.from({ length: 15 }, (_, index) => ({
                rel: "System.LinkTypes.Hierarchy-Forward",
                url: `https://dev.azure.com/acme/_apis/wit/workItems/${index + 20}`,
              })),
            ],
          });
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "workitems")
          return encode({
            value: args
              .find((arg) => arg.startsWith("ids="))!
              .slice(4)
              .split(",")
              .map((key) => ({
                ...WORK_ITEM,
                id: Number(key),
                fields: {
                  ...WORK_ITEM.fields,
                  "System.TeamProject": `Project ${key}`,
                  "System.WorkItemType": "Bug",
                  "System.State": "Review",
                },
              })),
          });
        if (resource === "workitemtypes")
          return encode({
            value: [{ name: "Bug", states: [{ name: "Review", category: "InProgress" }] }],
          });
        throw new Error(`Unexpected ${resource}`);
      });
      const target = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        limit: 100,
      };
      const first = yield* api.getHierarchy!(target);
      expect(first.parent?.key).toBe("4");
      expect(first.children.items.map((item) => item.key)).toEqual(
        Array.from({ length: 10 }, (_, index) => String(index + 20)),
      );
      expect(first.children.nextCursor).toBe("10");
      expect(calls).toBe(13);
      calls = 0;
      const second = yield* api.getHierarchy!({ ...target, cursor: first.children.nextCursor! });
      expect(second.children.items.map((item) => item.key)).toEqual(["30", "31", "32", "33", "34"]);
      expect(second.children.nextCursor).toBeNull();
      expect(calls).toBe(8);
    }),
  );

  it.effect("lists a project GUID through its native project name", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        if (args[1] === "project")
          return encode({
            id: "a0000000-0000-0000-0000-000000000001",
            name: "Web App",
            defaultTeam: { id: "team" },
          });
        const resource = args[args.indexOf("--resource") + 1];
        expect(args).toContain("project=Web App");
        return resource === "wiql"
          ? encode({ workItems: [{ id: 7 }] })
          : encode({ value: [WORK_ITEM] });
      });
      expect(
        yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/a0000000-0000-0000-0000-000000000001",
          state: "all",
          involvement: "all",
          viewer: "julius",
          limit: 1,
        }),
      ).toMatchObject({ items: [{ key: "7" }] });
    }),
  );

  it.effect.each(["all", "open"] as const)(
    "uses one inline workflow read for a list page across 100 native types in state %s",
    (state) =>
      Effect.gen(function* () {
        let workflowReads = 0;
        let calls = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "wiql")
            return encode({ workItems: Array.from({ length: 101 }, (_, id) => ({ id: id + 7 })) });
          if (resource === "workitems")
            return encode({
              value: Array.from({ length: 100 }, (_, index) => ({
                ...WORK_ITEM,
                id: index + 7,
                fields: {
                  ...WORK_ITEM.fields,
                  "System.WorkItemType": `Type ${index}`,
                  "System.TeamProject": index % 2 === 0 ? "Web App" : "WEB APP",
                  "System.State": "Review",
                },
              })),
            });
          if (resource === "workitemtypes") {
            workflowReads += 1;
            return encode({
              value: Array.from({ length: 100 }, (_, index) => ({
                name: `Type ${index}`,
                states: [
                  { name: "Review", category: "InProgress" },
                  { name: "Shipped", category: "Completed" },
                ],
              })),
            });
          }
          throw new Error(`Unexpected ${resource}`);
        });
        const page = yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state,
          involvement: "all",
          viewer: "julius@acme.test",
          sort: "comments",
          order: "asc",
          limit: 100,
        });
        expect(page.items.map((item) => item.state)).toEqual(
          Array.from({ length: 100 }, () => ({
            category: "open",
            name: "Review",
            id: "Review",
            workflowCategory: "started",
          })),
        );
        expect(JSON.parse(page.nextCursor!)).toEqual({
          sort: "comments",
          order: "asc",
          value: 2,
          id: 106,
        });
        expect(workflowReads).toBe(1);
        expect(calls).toBe(3);
      }),
  );

  it.effect("creates with native template fields and changes a parent under a revision check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const patches: unknown[] = [];
      const item = {
        ...WORK_ITEM,
        rev: 6,
        fields: { ...WORK_ITEM.fields, "System.WorkItemType": "Bug" },
        relations: [
          {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/4",
          },
        ],
      };
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystem.layer,
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              execute: ({ args }) =>
                Effect.gen(function* () {
                  const resource = args[args.indexOf("--resource") + 1];
                  const inFile = args.indexOf("--in-file");
                  if (inFile >= 0) {
                    expect(args[args.indexOf("--media-type") + 1]).toBe(
                      "application/json-patch+json",
                    );
                    patches.push(
                      JSON.parse(yield* fs.readFileString(args[inFile + 1]!).pipe(Effect.orDie)),
                    );
                    return TestSourceControlHost.processOutput(encode({ ...item, id: 55 }));
                  }
                  if (args[0] === "boards") {
                    const id = Number(args[args.indexOf("--id") + 1]);
                    return TestSourceControlHost.processOutput(
                      encode({
                        ...item,
                        id,
                        url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
                      }),
                    );
                  }
                  if (args[0] === "devops" && args[1] === "project")
                    return TestSourceControlHost.processOutput(
                      encode({ id: "project-id", name: "Web App", defaultTeam: { id: "team-id" } }),
                    );
                  if (resource === "workitemtypes")
                    return TestSourceControlHost.processOutput(
                      encode({ value: [{ name: "Bug" }] }),
                    );
                  if (resource === "templates")
                    return TestSourceControlHost.processOutput(
                      encode({
                        id: "bug-template",
                        name: "Bug",
                        workItemTypeName: "Bug",
                        fields: { "System.Title": "Default title", "Custom.Priority": "High" },
                      }),
                    );
                  throw new Error(`Unexpected ${args.join(" ")}`);
                }),
            }),
          ),
        ),
      );
      const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
      expect(
        yield* api.create!({
          ...target,
          title: "User title",
          body: "Body",
          labels: [],
          assignees: [],
          templateKey: "bug-template",
          parentKey: "8",
        }),
      ).toMatchObject({ key: "55", parentLinked: true });
      expect(patches[0]).toEqual(
        expect.arrayContaining([
          { op: "add", path: "/fields/System.Title", value: "User title" },
          { op: "add", path: "/fields/Custom.Priority", value: "High" },
          {
            op: "add",
            path: "/relations/-",
            value: {
              rel: "System.LinkTypes.Hierarchy-Reverse",
              url: "https://dev.azure.com/acme/_apis/wit/workItems/8",
            },
          },
        ]),
      );
      yield* api.setParent!({ ...target, parentKey: "8" });
      yield* api.setParent!({ ...target, parentKey: null });
      expect(patches[1]).toEqual([
        { op: "test", path: "/rev", value: 6 },
        { op: "remove", path: "/relations/0" },
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/8",
          },
        },
      ]);
      expect(patches[2]).toEqual([
        { op: "test", path: "/rev", value: 6 },
        { op: "remove", path: "/relations/0" },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("pages child relations into their own projects", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        if (args[0] === "boards")
          return encode({
            ...WORK_ITEM,
            relations: [8, 9].map((id) => ({
              rel: "System.LinkTypes.Hierarchy-Forward",
              url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
            })),
          });
        expect(args).toContain("ids=9");
        return encode({
          value: [
            {
              ...WORK_ITEM,
              id: 9,
              fields: { ...WORK_ITEM.fields, "System.TeamProject": "Other App" },
            },
          ],
        });
      });
      expect(
        yield* api.getHierarchy!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          cursor: "1",
          limit: 1,
        }),
      ).toMatchObject({
        parent: null,
        children: { items: [{ scope: "acme/Other App", key: "9" }], nextCursor: null },
      });
    }),
  );

  it.effect("lets the native token decide comment edit rights when the viewer is unknown", () =>
    Effect.gen(function* () {
      const paths: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        paths.push(args);
        if (args[0] === "boards") return encode(WORK_ITEM);
        return encode({ id: 1, createdBy: { uniqueName: "someone@acme.test" } });
      });
      yield* api.editComment!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        commentId: "1",
        body: "Changed",
      });
      expect(paths).toHaveLength(2);
      expect(paths.flat()).not.toContain("profiles");
      expect(paths.flat()).toContain("PATCH");
    }),
  );

  it("skips malformed artifact relation escaping", () => {
    expect(
      pullRequestNumberOf({
        rel: "ArtifactLink",
        url: "vstfs:///Git/PullRequestId/project%ZZrepo%2F50",
      }),
    ).toBeNull();
  });

  it.each([
    [
      "https://dev.azure.com/acme/_apis/wit/workItems/7",
      "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
    ],
    [
      "https://dev.azure.com/acme/Web%20App/_apis/wit/workItems/7",
      "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/Web%20App/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/7",
    ],
    ["not a URL", null],
    ["https://[acme/_apis/wit/workItems/7", null],
  ])("decodes native work-item URLs for detail, create and lists: %s", (url, expected) => {
    const item = { ...WORK_ITEM, url };
    const detail = Result.getOrThrow(decodeWorkItemJson(encode(item)));
    const list = Result.getOrThrow(decodeWorkItemsJson(encode({ value: [item] })));
    expect(detail?.url ?? null).toBe(expected);
    expect(list.map((row) => row.url)).toEqual(expected === null ? [] : [expected]);
  });

  it.effect("declares only native comment reactions", () =>
    Effect.gen(function* () {
      const api = yield* tracker(() => {
        throw new Error("Capabilities must not call Azure");
      });
      expect(api.capabilities).toMatchObject({
        reactions: false,
        commentReactions: true,
        reactionContents: ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"],
      });
    }),
  );

  it.effect.each([
    { content: "thumbs-up", native: "like" },
    { content: "thumbs-down", native: "dislike" },
    { content: "heart", native: "heart" },
    { content: "hooray", native: "hooray" },
    { content: "laugh", native: "smile" },
    { content: "confused", native: "confused" },
  ] as const)("adds and removes native comment reaction $native", ({ content, native }) =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        return args[0] === "boards" ? encode(WORK_ITEM) : "{}";
      });
      for (const reacted of [true, false]) {
        yield* api.setReaction!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          subjectId: "12",
          content,
          reacted,
        });
      }
      expect(seen).toHaveLength(4);
      for (const [index, method] of [
        [1, "PUT"],
        [3, "DELETE"],
      ] as const) {
        expect(seen[index]).toEqual(
          expect.arrayContaining([
            "commentsReactions",
            "workItemId=7",
            "commentId=12",
            `reactionType=${native}`,
            method,
            "api-version=7.1-preview.1",
          ]),
        );
      }
    }),
  );

  it.effect("maps a work item, its conversation and revisions to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: string[][] = [];
      const api = yield* tracker((args) => {
        seen.push([...args]);
        return answer(args);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      });
      // Every command names the organization rather than detecting it from the checkout.
      for (const args of seen) {
        expect(args).toContain("https://dev.azure.com/acme");
      }
      expect(issue).toMatchObject({
        key: "7",
        displayKey: "#7",
        title: "Composer loses focus",
        url: "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
        // The project's own state name survives; the category is what the list filters by.
        state: { category: "closed", name: "Resolved" },
        author: { login: "octo@acme.test", name: "Octo Cat" },
        assignees: [{ login: "Theo <theo@acme.test>" }],
        labels: [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
        commentCount: 2,
        body: "<p>Typing drops focus.</p>",
        commentsCursor: "next-token",
        historyTruncated: false,
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
      });
      expect(issue.comments).toEqual([
        {
          id: "1",
          author: { login: "julius@acme.test", name: "Julius", avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
          editedAt: null,
          canEdit: false,
          url: null,
          reactions: [{ content: "thumbs-up", count: 2, actors: [], viewerHasReacted: true }],
        },
      ]);
      // The first revision is the creation; a state move across the category line is a close.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["closed", "Resolved"],
        ["labeled", "bug"],
      ]);
      expect(issue.events.map((event) => event.createdAt)).toEqual([
        "2026-07-03T00:00:00Z",
        "2026-07-03T00:00:00Z",
      ]);
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "Web App/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50",
          state: "merged",
          isDraft: false,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect(
    "marks a full native update page as partial even when most updates have no events",
    () =>
      Effect.gen(function* () {
        for (const total of [101, 100, 99]) {
          const seen: ReadonlyArray<string>[] = [];
          const updates = Array.from({ length: total }, (_, index) => ({
            id: index + 1,
            rev: 2,
            revisedDate: "9999-01-01T00:00:00Z",
            revisedBy: { uniqueName: "theo@acme.test" },
            fields: {
              "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
              ...(index === total - 1
                ? { "System.State": { oldValue: "Active", newValue: "Resolved" } }
                : index === 1
                  ? {
                      "System.Title": { oldValue: "Old title", newValue: "New title" },
                      "System.Tags": { oldValue: "", newValue: "bug" },
                    }
                  : {}),
            },
          }));
          const api = yield* tracker((args) => {
            seen.push(args);
            const resource = args[args.indexOf("--resource") + 1];
            if (resource === "updates") {
              const top = Number(args.find((arg) => arg.startsWith("$top="))?.slice(5));
              return encode({ count: Math.min(top, total), value: updates.slice(0, top) });
            }
            return answer(args);
          });
          const issue = yield* api.getIssue({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            key: "7",
          });
          expect(issue.historyTruncated).toBe(total >= 100);
          expect(issue.state).toEqual({ category: "closed", name: "Resolved" });
          expect(issue.events.map((event) => event.kind)).toEqual(
            total <= 100 ? ["renamed", "labeled", "closed"] : ["renamed", "labeled"],
          );
          expect(issue.events[0]).toMatchObject({
            id: "update-2-0",
            actor: { login: "theo@acme.test" },
            createdAt: "2026-07-03T00:00:00Z",
            detail: "New title",
          });
          expect(seen).toHaveLength(4);
          expect(seen.filter((args) => args.includes("updates"))).toHaveLength(1);
          expect(seen.find((args) => args.includes("updates"))).toContain("$top=100");
        }
      }),
  );

  it.effect("lists the native bulk work-item wrapper in one bounded page", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "wiql")
          return encode({ workItems: [{ id: 7 }, { id: 8 }], asOf: "2026-07-04T00:00:00Z" });
        if (resource === "workitems") return encode({ count: 1, value: [WORK_ITEM] });
        throw new Error(`Unexpected resource ${resource}`);
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "all",
        involvement: "all",
        viewer: "julius@acme.test",
        limit: 1,
      });
      expect(page.items.map((item) => item.key)).toEqual(["7"]);
      expect(page.nextCursor).toBe("2026-07-03T00:00:00Z|7");
      expect(seen).toHaveLength(2);
      expect(seen[1]).toContain("ids=7");
      expect(seen[1]).toContain("asOf=2026-07-04T00:00:00Z");
    }),
  );

  it.effect("keeps WIQL ordering and its cursor when native bulk rows arrive by ID", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const rows = [1, 2, 3].map((id) => ({
        ...WORK_ITEM,
        id,
        fields: { ...WORK_ITEM.fields, "System.ChangedDate": `2026-07-0${id}T00:00:00Z` },
      }));
      let queries = 0;
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "wiql")
          return encode({
            workItems: (++queries === 1 ? [3, 2, 1] : [1]).map((id) => ({ id })),
          });
        if (resource === "workitems")
          return encode({
            count: queries === 1 ? 2 : 1,
            value: queries === 1 ? [rows[1], rows[2]] : [rows[0]],
          });
        throw new Error(`Unexpected resource ${resource}`);
      });
      const target = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "all" as const,
        involvement: "all" as const,
        viewer: "julius@acme.test",
        limit: 2,
      };
      const first = yield* api.listIssues(target);
      expect(first.items.map((item) => item.key)).toEqual(["3", "2"]);
      expect(first.nextCursor).toBe("2026-07-02T00:00:00Z|2");
      const second = yield* api.listIssues({ ...target, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.key)).toEqual(["1"]);
      expect(second.nextCursor).toBeNull();
      expect(seen).toHaveLength(4);
    }),
  );

  it.effect("refuses the unsupported mentioned filter before any Azure request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return encode({ workItems: [] });
      });
      const error = yield* Effect.flip(
        api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state: "all",
          involvement: "mentioned",
          viewer: "julius@acme.test",
          limit: 10,
        }),
      );
      expect(error.detail).toContain("mentioned");
      expect(requests).toBe(0);
      expect(api.capabilities.maxAssignees).toBe(1);
      expect(api.capabilities.involvements).toEqual(["all", "assigned", "authored"]);
    }),
  );

  it.effect.each(["update", "setState", "getIssue", "getComments"] as const)(
    "rejects a foreign native project before %s",
    (operation) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          return answer(args);
        });
        const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Other", key: "7" };
        const task =
          operation === "update"
            ? api.update!({ ...target, title: "Changed title" })
            : operation === "setState"
              ? api.setState!({ ...target, state: "New" })
              : operation === "getComments"
                ? api.getComments({ ...target, cursor: "next-token" })
                : api.getIssue(target);
        const error = yield* Effect.flip(task);
        expect(error.reason).toBe("not-found");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.slice(0, 3)).toEqual(["boards", "work-item", "show"]);
      }),
  );

  it.effect.each(["web app", "a0000000-0000-0000-0000-000000000001"])(
    "accepts the native project identity for configured scope %s before writing",
    (project) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          if (args.slice(0, 3).join(" ") === "devops project show")
            return encode({ id: "a0000000-0000-0000-0000-000000000001", name: "Web App" });
          return answer(args);
        });
        yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: `acme/${project}`,
          key: "7",
          title: "Changed title",
        });
        expect(seen[0]?.slice(0, 3)).toEqual(["boards", "work-item", "show"]);
        expect(seen.at(-1)?.slice(0, 3)).toEqual(["boards", "work-item", "update"]);
        expect(seen).toHaveLength(project === "web app" ? 2 : 3);
      }),
  );

  it.effect("refuses a scope that is not organization/project without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "{}";
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "dev.azure.com", scope: "web", key: "7" }),
      );
      expect(error.reason).toBe("failed");
      expect(requests).toBe(0);
    }),
  );
});
