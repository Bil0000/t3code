import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { pullRequestMediaResponse } from "./PullRequestMediaFetch.ts";

const asset = {
  version: 1 as const,
  kind: "pull-request-media" as const,
  provider: "gitlab" as const,
  reference: {
    projectId: Schema.decodeSync(ProjectId)("p1"),
    repository: "owner/repo",
    number: 7,
    host: "gitlab.example",
    expectedAccountId: "account-1",
  },
  url: `https://gitlab.example/owner/repo/uploads/${"a".repeat(32)}/clip.mp4`,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

it.effect("preserves signed PR scope and ranges while stripping auth on redirected media", () => {
  const redirects: string[] = [];
  return Effect.gen(function* () {
    const response = yield* pullRequestMediaResponse(asset, {
      range: "bytes=1-3",
      "if-range": "etag",
      authorization: "browser-token",
      cookie: "browser-cookie",
    });
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 1-3/5");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(redirects).toEqual(["https://storage.example/signed-object"]);
  }).pipe(
    Effect.provide(
      Layer.mock(PullRequestService)({
        readAttachment: (input) => {
          expect(input.expectedAccountId).toBe("account-1");
          expect(input.repository).toBe("owner/repo");
          expect(input.headers).toEqual({
            range: "bytes=1-3",
            "if-range": "etag",
            "accept-encoding": "identity",
          });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              HttpClientRequest.get(asset.url),
              new Response(null, {
                status: 302,
                headers: { location: "https://storage.example/signed-object" },
              }),
            ),
          );
        },
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        redirects.push(request.url);
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers.range).toBe("bytes=1-3");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([0, 128, 255]), {
              status: 206,
              headers: { "content-type": "video/mp4", "content-range": "bytes 1-3/5" },
            }),
          ),
        );
      }),
    ),
    Effect.scoped,
  );
});

for (const [contentType, expected] of [
  ["image/svg+xml", 200],
  ["text/html", 415],
] as const) {
  it.effect(`keeps SVG sandbox and refuses active ${contentType} responses`, () =>
    Effect.gen(function* () {
      const response = yield* pullRequestMediaResponse(
        { ...asset, url: asset.url.replace("clip.mp4", "document") },
        {},
      );
      expect(response.status).toBe(expected);
      if (expected === 200)
        expect(response.headers["content-security-policy"]).toContain("sandbox");
    }).pipe(
      Effect.provide(
        Layer.mock(PullRequestService)({
          readAttachment: () =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                HttpClientRequest.get(asset.url),
                new Response("<svg/>", { headers: { "content-type": contentType } }),
              ),
            ),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("No redirect expected")),
      ),
      Effect.scoped,
    ),
  );
}
