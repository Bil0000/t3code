import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

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
