import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";
import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";
import * as BitbucketIssueProvider from "./BitbucketIssueProvider.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
import * as GitLabIssueCli from "./GitLabIssueCli.ts";
import * as GitLabIssueProvider from "./GitLabIssueProvider.ts";
import type { IssueProviderApi } from "./IssueProvider.ts";

export class IssueProviderRegistry extends Context.Service<
  IssueProviderRegistry,
  {
    /** Null for a host with no implementation, which the service reports as unsupported. */
    readonly get: (kind: SourceControlProviderKind) => IssueProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/issue/IssueProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
export function fromProviders(
  providers: ReadonlyArray<IssueProviderApi>,
): IssueProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/**
 * The hosts this build can read issues from. A host with no entry here still shows up in the
 * provider list as unimplemented, so its projects are explained rather than missing.
 */
export const make = Effect.map(
  Effect.all([
    GitHubIssueProvider.make,
    GitLabIssueProvider.make,
    BitbucketIssueProvider.make,
    AzureDevOpsIssueProvider.make,
  ]),
  fromProviders,
);

export const layer = Layer.effect(IssueProviderRegistry, make).pipe(
  Layer.provide(GitHubIssueCli.layer.pipe(Layer.provide(GitHubCli.layer))),
  Layer.provide(GitLabIssueCli.layer.pipe(Layer.provide(GitLabCli.layer))),
  Layer.provide(BitbucketIssueApi.layer.pipe(Layer.provide(BitbucketApi.layer))),
  Layer.provide(AzureDevOpsIssueCli.layer.pipe(Layer.provide(AzureDevOpsCli.layer))),
);
