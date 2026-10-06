import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  IssueOperationError,
  PullRequestOperationError,
  TextGenerationError,
  type IssueDetail,
  type IssueListResult,
  type PullRequestDetail,
  type PullRequestListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkItemMatches from "./WorkItemMatches.ts";

const projectId = ProjectId.make("project");
const item = (number: number) => ({
  projectId,
  provider: "github",
  repository: "acme/app",
  number,
  title: "Session refresh",
  url: `https://github.com/acme/app/issues/${number}`,
});
const detail = (number: number) => ({
  ...item(number),
  workspaceRoot: "/workspace",
  body: "Refresh expired sessions",
  capabilities: { referenceStyle: "hash" },
  linkedPullRequests: [item(2)],
  linkedIssues: [item(2)],
});
const dependencies = Layer.mergeAll(
  Layer.mock(IssueService.IssueService)({
    detail: ({ number }) => Effect.succeed(detail(number) as unknown as IssueDetail),
    list: () =>
      Effect.succeed({ entries: [item(1), item(2), item(3)] } as unknown as IssueListResult),
  }),
  Layer.mock(PullRequestService.PullRequestService)({
    detail: ({ number }) => Effect.succeed(detail(number) as unknown as PullRequestDetail),
    list: () =>
      Effect.succeed({ entries: [item(1), item(2), item(3)] } as unknown as PullRequestListResult),
  }),
  ServerSettings.layerTest(),
);

describe("WorkItemMatches", () => {
  it.effect.each([
    { kind: "issue", relationship: "related" },
    { kind: "issue", relationship: "duplicate" },
    { kind: "pull-request", relationship: "related" },
    { kind: "pull-request", relationship: "duplicate" },
  ] as const)(
    "matches $kind $relationship candidates through the service",
    ({ kind, relationship }) =>
      Effect.gen(function* () {
        const textGeneration = Layer.mock(TextGeneration.TextGeneration)({
          findWorkItemMatches: (input) => {
            expect(input.cwd).toBe("/workspace");
            expect(input.relationship).toBe(relationship);
            expect(input.source.kind).toBe(kind);
            expect(input.candidates.map((candidate) => candidate.number)).toEqual(
              relationship === "related" ? [1, 3] : [2, 3],
            );
            expect(
              input.candidates.every(
                (candidate) =>
                  candidate.kind ===
                  (relationship === "duplicate"
                    ? kind
                    : kind === "issue"
                      ? "pull-request"
                      : "issue"),
              ),
            ).toBe(true);
            return Effect.succeed({
              matches: [
                { candidate: 2, confidence: "high", reason: "Same session fix" },
                { candidate: 99, confidence: "high", reason: "Invalid" },
              ],
            });
          },
        });
        const service = yield* WorkItemMatches.WorkItemMatches.pipe(
          Effect.provide(
            WorkItemMatches.layer.pipe(Layer.provide(dependencies), Layer.provide(textGeneration)),
          ),
        );
        const result = yield* service.find({
          projectId,
          relationship,
          source: { ...item(1), kind },
        });
        expect(result.matches.map((match) => match.number)).toEqual([3]);
      }),
  );

  it.effect("skips generation when no candidates remain", () =>
    Effect.gen(function* () {
      const service = yield* WorkItemMatches.WorkItemMatches;
      expect(
        yield* service.find({
          projectId,
          relationship: "duplicate",
          source: { ...item(1), kind: "issue" },
        }),
      ).toEqual({ matches: [] });
    }).pipe(
      Effect.provide(
        WorkItemMatches.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              dependencies,
              Layer.mock(IssueService.IssueService)({
                detail: () => Effect.succeed(detail(1) as unknown as IssueDetail),
                list: () => Effect.succeed({ entries: [item(1)] } as unknown as IssueListResult),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                findWorkItemMatches: () => Effect.die("Must not generate"),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect.each(["read-source", "list-candidates", "read-candidate", "generate"] as const)(
    "preserves the underlying $0 failure",
    (stage) =>
      Effect.gen(function* () {
        const issueCause = new IssueOperationError({ operation: "detail", detail: "Failed" });
        const pullRequestCause = new PullRequestOperationError({
          operation: "detail",
          detail: "Failed",
        });
        const generationCause = new TextGenerationError({
          operation: "findWorkItemMatches",
          detail: "Failed",
        });
        const service = yield* WorkItemMatches.WorkItemMatches.pipe(
          Effect.provide(
            WorkItemMatches.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  Layer.mock(IssueService.IssueService)({
                    detail: () =>
                      stage === "read-source"
                        ? Effect.fail(issueCause)
                        : Effect.succeed(detail(1) as unknown as IssueDetail),
                  }),
                  Layer.mock(PullRequestService.PullRequestService)({
                    detail: () =>
                      stage === "read-candidate"
                        ? Effect.fail(pullRequestCause)
                        : Effect.succeed(detail(3) as unknown as PullRequestDetail),
                    list: () =>
                      stage === "list-candidates"
                        ? Effect.fail(pullRequestCause)
                        : Effect.succeed({
                            entries: [item(3)],
                          } as unknown as PullRequestListResult),
                  }),
                  Layer.mock(TextGeneration.TextGeneration)({
                    findWorkItemMatches: () => Effect.fail(generationCause),
                  }),
                ),
              ),
            ),
          ),
        );
        const error = yield* service
          .find({ projectId, relationship: "related", source: { ...item(1), kind: "issue" } })
          .pipe(Effect.flip);
        expect(error.operation).toBe(stage);
        expect(error.cause).toBe(
          stage === "generate"
            ? generationCause
            : stage === "read-source"
              ? issueCause
              : pullRequestCause,
        );
      }),
  );
});
