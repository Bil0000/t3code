import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import { PullRequestProviderRegistry, makeRegistry } from "./PullRequestProvider.ts";

/**
 * The hosts this build can read change requests from. A host with no entry here still shows up
 * in the provider list as unimplemented, so its projects are explained rather than missing.
 */
export const registryLayer = Layer.effect(
  PullRequestProviderRegistry,
  Effect.map(
    Effect.all([
      GitHubPullRequestProvider.make,
      GitLabPullRequestProvider.make,
      BitbucketPullRequestProvider.make,
    ]),
    (providers) => makeRegistry(providers),
  ),
).pipe(
  Layer.provide(GitHubPullRequestCli.layer.pipe(Layer.provide(GitHubCli.layer))),
  Layer.provide(GitLabPullRequestCli.layer.pipe(Layer.provide(GitLabCli.layer))),
  Layer.provide(BitbucketPullRequestApi.layer.pipe(Layer.provide(BitbucketApi.layer))),
);
