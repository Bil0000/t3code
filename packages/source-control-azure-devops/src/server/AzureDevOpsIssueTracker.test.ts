import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";

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
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
      });
      expect(issue.comments).toEqual([
        {
          id: "1",
          author: { login: "julius@acme.test", name: "Julius", avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
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

  it.effect("lists the native bulk work-item wrapper in one bounded page", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "wiql") return encode({ workItems: [{ id: 7 }, { id: 8 }] });
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
