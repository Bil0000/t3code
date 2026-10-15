import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { IssueCommentsPage } from "@t3tools/contracts";
import * as HttpClient from "effect/http/HttpClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

const decodeCommentsPage = Schema.decodeEffect(IssueCommentsPage);

it.effect.each([
  {
    name: "HTTPS root control",
    baseUrl: "https://forgejo.test:3000",
    remote: "https://forgejo.test:3000/acme/web.git",
  },
  {
    name: "HTTPS explicit mount control",
    baseUrl: "https://forgejo.test:3000/mount-a",
    remote: "https://forgejo.test:3000/mount-a/acme/web.git",
    scope: "mount-a/acme/web",
  },
  {
    name: "SSH mounted install",
    baseUrl: "https://forgejo.test:3000/mount-a",
    remote: "git@forgejo.test:acme/web.git",
  },
  {
    name: "explicit HTTP install",
    baseUrl: "http://forgejo.test:3000",
    remote: "http://forgejo.test:3000/acme/web.git",
  },
])("keeps the native browser destination for $name", ({ baseUrl, remote, scope }) => {
  const nativeReads: string[] = [];
  let keyChecks = 0;
  let gitReads = 0;
  let loginReads = 0;
  const filename = ".forgejo/ISSUE_TEMPLATE/incident.yaml";
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const tracker = yield* ForgejoIssueTracker.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const result = yield* tracker.listTemplates!({
      cwd: "/fixture",
      host: "forgejo.test:3000",
      scope: scope ?? "acme/web",
    });
    expect(nativeReads.sort()).toEqual([
      `${baseUrl}/api/v1/repos/acme/web/issue_config`,
      `${baseUrl}/api/v1/repos/acme/web/issue_templates`,
    ]);
    expect(keyChecks).toBe(2);
    expect(gitReads).toBe(2);
    expect(loginReads).toBe(2);
    expect(result.blankIssuesEnabled).toBe(false);
    expect(result.templates).toHaveLength(0);
    expect(result.externalTemplates).toHaveLength(1);
    const expected = new URL(`${baseUrl}/acme/web/issues/new`);
    expected.searchParams.set("template", filename);
    expect(result.externalTemplates![0]!.url).toBe(expected.href);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => {
          keyChecks++;
          return Effect.succeed(false);
        },
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP transport")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git") {
              gitReads++;
              return Effect.succeed(
                TestSourceControlHost.processOutput(`origin\t${remote} (fetch)\n`),
              );
            }
            if (input.command !== "tea") return Effect.die(`Unexpected command ${input.command}`);
            if (input.args[0] === "login") {
              loginReads++;
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify([
                    {
                      name: "fixture",
                      url: baseUrl,
                      ssh_host: "forgejo.test",
                      user: "alice",
                      default: "true",
                    },
                  ]),
                ),
              );
            }
            const url = input.args.at(-1)!;
            nativeReads.push(url);
            const payload = url.endsWith("/issue_config")
              ? { blank_issues_enabled: false }
              : [
                  {
                    file_name: filename,
                    name: "Incident",
                    body: [
                      {
                        type: "input",
                        id: "ticket",
                        attributes: { label: "Ticket" },
                        validations: { is_number: true },
                      },
                    ],
                  },
                ];
            return Effect.succeed(
              TestSourceControlHost.processOutput(JSON.stringify(payload), {
                stderr: "HTTP/1.1 200\n",
              }),
            );
          },
        },
      }),
    ),
  );
});

it.effect.each([
  { name: "native writer", push: true, author: false, archived: false },
  { name: "comment author", push: false, author: true, archived: false },
  { name: "known reader", push: false, author: false, archived: false },
  { name: "archived repository", push: true, author: false, archived: true },
])("keeps continuation edit permission optional for $name", ({ push, author, archived }) => {
  const native: string[] = [];
  const baseUrl = "https://forgejo.test:3000/Mount";
  let nativeBody = "Comment";
  const comments = Array.from({ length: 60 }, (_, index) => ({
    id: index + 1,
    body: nativeBody,
    user: { login: author ? "viewer" : "other" },
    created_at: "2026-10-01T00:00:00Z",
  }));
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const tracker = yield* ForgejoIssueTracker.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const ref = { cwd: "/fixture", host: "forgejo.test:3000", scope: "Mount/acme/web", key: "42" };
    const first = yield* tracker.getIssue(ref);
    expect(first.comments).toHaveLength(50);
    expect(
      first.comments.every((comment) => comment.canEdit === (!archived && (push || author))),
    ).toBe(true);
    expect(native).toHaveLength(56);
    native.length = 0;
    const next = yield* tracker
      .getComments({
        ...ref,
        cursor: first.commentsCursor!,
        viewer: first.viewer ?? "",
      })
      .pipe(Effect.flatMap(decodeCommentsPage));
    expect(next.comments.map((comment) => comment.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 51)),
    );
    for (const comment of next.comments) {
      if (author) expect(comment.canEdit).toBe(true);
      else expect(comment).not.toHaveProperty("canEdit");
    }
    expect(native).toHaveLength(11);
    expect(native[0]).toBe("repos/acme/web/issues/42/comments?limit=50&page=1");
    expect(
      native
        .slice(1)
        .every((path) => /^repos\/acme\/web\/issues\/comments\/\d+\/reactions$/.test(path)),
    ).toBe(true);
    if (!archived) {
      native.length = 0;
      const edit = tracker.editComment!({ ...ref, commentId: "51", body: "Draft text" });
      if (push || author) yield* edit;
      else
        expect(yield* Effect.flip(edit)).toMatchObject({
          reason: "failed",
          cause: { reason: "forbidden", httpStatus: 403 },
        });
      expect(nativeBody).toBe(push || author ? "Draft text" : "Comment");
      expect(native).toEqual([
        "repos/acme/web/issues/comments/51",
        "repos/acme/web/issues/comments/51",
      ]);
    }
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP transport")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git")
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  "origin\t" + baseUrl + "/acme/web.git (fetch)\n",
                ),
              );
            if (input.command !== "tea") return Effect.die("Unexpected command " + input.command);
            if (input.args[0] === "login")
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify([
                    { name: "fixture", url: baseUrl, user: "viewer", default: "true" },
                  ]),
                ),
              );
            const url = new URL(input.args.at(-1)!);
            expect(url.origin + "/Mount").toBe(baseUrl);
            const path = url.pathname.slice("/Mount/api/v1/".length);
            native.push(path + url.search);
            if (input.args[input.args.indexOf("--method") + 1] === "PATCH") {
              expect(JSON.parse(input.stdin!)).toEqual({ body: "Draft text" });
              if (!push && !author)
                return Effect.succeed(
                  TestSourceControlHost.processOutput("{}", { stderr: "HTTP/1.1 403 Forbidden\n" }),
                );
              nativeBody = "Draft text";
            }
            const payload =
              path === "user"
                ? { login: "viewer" }
                : path === "repos/acme/web"
                  ? { full_name: "acme/web", permissions: { push, admin: push }, archived }
                  : path === "repos/acme/web/issues/42"
                    ? {
                        number: 42,
                        title: "Issue",
                        body: "",
                        html_url: baseUrl + "/acme/web/issues/42",
                        user: { login: "other" },
                        state: "open",
                        created_at: "2026-10-01T00:00:00Z",
                        updated_at: "2026-10-01T00:00:00Z",
                        comments: 60,
                      }
                    : path === "repos/acme/web/issues/42/comments"
                      ? comments
                      : path === "repos/acme/web/issues/comments/51"
                        ? { id: 51, issue_url: baseUrl + "/api/v1/repos/acme/web/issues/42" }
                        : [];
            return Effect.succeed(
              TestSourceControlHost.processOutput(JSON.stringify(payload), {
                stderr: "HTTP/1.1 200\n",
              }),
            );
          },
        },
      }),
    ),
  );
});
