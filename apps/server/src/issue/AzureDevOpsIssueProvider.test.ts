import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";

it.effect("maps CLI rate limits without changing other Azure DevOps failures", () =>
  Effect.gen(function* () {
    const context = {
      operation: "execute" as const,
      command: "az" as const,
      cwd: "/repo",
      argumentCount: 1,
      cause: new Error("provider failure"),
    };
    for (const [source, reason] of [
      [new AzureDevOpsCli.AzureDevOpsCliRateLimitError(context), "rate-limited"],
      [new AzureDevOpsCli.AzureDevOpsCliUnavailableError(context), "missing-tool"],
      [new AzureDevOpsCli.AzureDevOpsCliAuthenticationError(context), "unauthenticated"],
      [new AzureDevOpsCli.AzureDevOpsCommandFailedError(context), "failed"],
    ] as const) {
      const provider = yield* AzureDevOpsIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsIssueCli.AzureDevOpsIssueCli)({
            listWorkItems: () => Effect.fail(source),
            runWorkItemAction: () => Effect.fail(source),
          }),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "dev.azure.com" };
      for (const request of [
        provider.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
        provider.runAction({ ...reference, number: 7, action: "close" }),
      ]) {
        const error = yield* Effect.flip(request);
        assert.strictEqual(error._tag, "IssueProviderError");
        assert.strictEqual(error.provider, "azure-devops");
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.retryAt, undefined);
        assert.strictEqual(error.detail, source.detail);
        assert.strictEqual(error.cause, source);
      }
    }
  }),
);
