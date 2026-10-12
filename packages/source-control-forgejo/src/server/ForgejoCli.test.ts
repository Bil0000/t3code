import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const now = Date.parse("2026-10-12T12:00:00Z");
const cases = [
  { status: 429, header: "120", reason: "rate-limit", retryAt: now + 120_000 },
  {
    status: 429,
    header: "Mon, 12 Oct 2026 12:03:00 GMT",
    reason: "rate-limit",
    retryAt: now + 180_000,
  },
  { status: 429, header: "later", reason: "rate-limit", retryAt: undefined },
  { status: 429, header: undefined, reason: "rate-limit", retryAt: undefined },
  { status: 429, header: "9".repeat(400), reason: "rate-limit", retryAt: undefined },
  {
    status: 429,
    header: "Mon, 12 Oct 2026 11:59:00 GMT",
    reason: "rate-limit",
    retryAt: undefined,
  },
  { status: 401, header: "120", reason: "authentication", retryAt: undefined },
  { status: 403, header: "120", reason: "forbidden", retryAt: undefined },
  { status: 404, header: "120", reason: "not-found", retryAt: undefined },
];

it.effect.each(
  (["fj", "tea"] as const).flatMap((command) => cases.map((test) => ({ ...test, command }))),
)(
  "preserves $command HTTP $status with Retry-After $header",
  ({ command, status, header, reason, retryAt }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const cli = yield* ForgejoCli.make;
      const error = yield* cli
        .api({
          cwd: "/repo",
          repository: "https://forgejo.test/maria/project",
          path: "repos/maria/project/issues/42/timeline",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.command, command);
      assert.strictEqual(error.httpStatus, status);
      assert.strictEqual(error.reason, reason);
      assert.strictEqual(error.retryAt, retryAt);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(command === "fj"),
          readFileString: () =>
            Effect.succeed(
              encodeJson({
                hosts: { "forgejo.test": { type: "Application", token: "test-token" } },
              }),
            ),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          assert.strictEqual(command, "fj");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                status,
                headers: header === undefined ? {} : { "Retry-After": header },
              }),
            ),
          );
        }),
      ),
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) =>
              Effect.succeed(
                input.args[0] === "login"
                  ? TestSourceControlHost.processOutput(
                      encodeJson([
                        {
                          name: "work",
                          url: "https://forgejo.test",
                          user: "maria",
                          default: "true",
                        },
                      ]),
                    )
                  : TestSourceControlHost.processOutput("{}", {
                      stderr: `HTTP/1.1 ${status}\r\n${header === undefined ? "" : `rEtRy-AfTeR: ${header}\r\n`}`,
                    }),
              ),
          },
        }),
      ),
    ),
);

it("accepts only finite retryAt values in ForgejoCliError", () => {
  for (const retryAt of [now, undefined])
    assert.doesNotThrow(
      () =>
        new ForgejoCli.ForgejoCliError({ command: "fj", cwd: "/repo", detail: "limited", retryAt }),
    );
  for (const retryAt of [NaN, Infinity, -Infinity])
    assert.throws(
      () =>
        new ForgejoCli.ForgejoCliError({ command: "fj", cwd: "/repo", detail: "limited", retryAt }),
    );
});
