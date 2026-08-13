import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";

const RESET_AT = "2026-08-13T14:00:00.000Z";
const BEFORE_RESET = Date.parse("2026-08-13T13:30:00.000Z");
const AFTER_RESET = Date.parse("2026-08-13T14:00:01.000Z");

function rateLimit(remaining: number, limit = 5_000): string {
  return JSON.stringify({
    data: {
      viewer: { login: "bilal" },
      rateLimit: { cost: 14, limit, remaining, resetAt: RESET_AT },
    },
  });
}

describe("GitHub GraphQL budget", () => {
  it.effect("adds rate metadata to a read query", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;

      const query = yield* budget.query(
        "github.com",
        'query { repository(owner: "acme", name: "web") { name } }',
      );

      expect(query).toContain("rateLimit { cost limit remaining resetAt }");
      expect(query).toContain('repository(owner: "acme", name: "web") { name }');
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("protects the last ten percent until reset", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(500));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error).toMatchObject({
        _tag: "GitHubGraphQlBudgetPausedError",
        host: "github.com",
        resetAt: RESET_AT,
      });
      expect(error.message).toBe(
        `GitHub GraphQL reads for github.com are paused until ${RESET_AT}.`,
      );

      yield* TestClock.setTime(AFTER_RESET);
      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("keeps hosts isolated", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(0));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error._tag).toBe("GitHubGraphQlBudgetPausedError");
      expect(yield* budget.query("github.example.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("allows reads above the reserve", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(501));

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("ignores malformed or partial rate metadata", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", "{");
      yield* budget.observe(
        "github.com",
        '{"data":{"rateLimit":{"limit":0,"remaining":-1,"resetAt":"never"}}}',
      );

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("does not add a read field to a mutation", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      const mutation = "mutation { addComment(input: {}) { clientMutationId } }";

      expect(yield* budget.query("github.com", mutation)).toBe(mutation);
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );
});
