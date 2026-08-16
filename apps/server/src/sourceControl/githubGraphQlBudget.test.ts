import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { createGitHubGraphQlBudget, GitHubGraphQlBudget, layer } from "./githubGraphQlBudget.ts";

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
  it("adds rate metadata to a read query", () => {
    const budget = createGitHubGraphQlBudget();
    const decision = budget.query(
      "github.com",
      'query { repository(owner: "acme", name: "web") { name } }',
      BEFORE_RESET,
    );

    expect(decision._tag).toBe("Allowed");
    if (decision._tag !== "Allowed") throw new Error("expected an allowed query");
    expect(decision.query).toContain("rateLimit { cost limit remaining resetAt }");
    expect(decision.query).toContain('repository(owner: "acme", name: "web") { name }');
  });

  it("adds rate metadata to the operation before trailing fragments", () => {
    const budget = createGitHubGraphQlBudget();
    const document = `query {
  repository(owner: "acme", name: "web") { ...RepositoryName }
}

fragment RepositoryName on Repository {
  name
}`;

    const decision = budget.query("github.com", document, BEFORE_RESET);

    expect(decision).toEqual({
      _tag: "Allowed",
      query: `query {
  repository(owner: "acme", name: "web") { ...RepositoryName }

  rateLimit { cost limit remaining resetAt }
}

fragment RepositoryName on Repository {
  name
}`,
    });
  });

  it("protects the last ten percent until reset", () => {
    const budget = createGitHubGraphQlBudget();
    budget.observe("github.com", rateLimit(500));

    expect(budget.query("github.com", "query { viewer { login } }", BEFORE_RESET)).toEqual({
      _tag: "Paused",
      resetAt: RESET_AT,
    });
    expect(budget.query("github.com", "query { viewer { login } }", AFTER_RESET)._tag).toBe(
      "Allowed",
    );
  });

  it("keeps hosts isolated", () => {
    const budget = createGitHubGraphQlBudget();
    budget.observe("github.com", rateLimit(0));

    expect(budget.query("github.com", "query { viewer { login } }", BEFORE_RESET)._tag).toBe(
      "Paused",
    );
    expect(
      budget.query("github.example.com", "query { viewer { login } }", BEFORE_RESET)._tag,
    ).toBe("Allowed");
  });

  it("allows reads above the reserve", () => {
    const budget = createGitHubGraphQlBudget();
    budget.observe("github.com", rateLimit(501));

    expect(budget.query("github.com", "query { viewer { login } }", BEFORE_RESET)._tag).toBe(
      "Allowed",
    );
  });

  it("ignores malformed or partial rate metadata", () => {
    const budget = createGitHubGraphQlBudget();
    budget.observe("github.com", "{");
    budget.observe(
      "github.com",
      JSON.stringify({ data: { rateLimit: { limit: 0, remaining: -1, resetAt: "never" } } }),
    );

    expect(budget.query("github.com", "query { viewer { login } }", BEFORE_RESET)._tag).toBe(
      "Allowed",
    );
  });

  it("does not add a read field to a mutation", () => {
    const budget = createGitHubGraphQlBudget();
    const mutation = "mutation { addComment(input: {}) { clientMutationId } }";
    const decision = budget.query("github.com", mutation, BEFORE_RESET);

    expect(decision).toEqual({ _tag: "Allowed", query: mutation });
  });

  it.effect("uses the injected clock to release the reserve", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(500));

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toEqual({
        _tag: "Paused",
        resetAt: RESET_AT,
      });

      yield* TestClock.setTime(AFTER_RESET);

      expect((yield* budget.query("github.com", "query { viewer { login } }"))._tag).toBe(
        "Allowed",
      );
    }).pipe(Effect.provide(layer)),
  );
});
