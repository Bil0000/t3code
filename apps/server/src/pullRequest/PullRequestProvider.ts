import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestState,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

/**
 * The one failure shape every provider reports, so the service can decide what a failure means
 * without knowing which CLI or API produced it.
 *
 * `reason` is the part the service acts on: a missing or unauthenticated tool disables the
 * provider for the whole workspace, while anything else is specific to the request.
 */
export class PullRequestProviderError extends Schema.TaggedErrorClass<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/** A change request as the provider sees it, before the service attaches project context. */
export interface ProviderChangeRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: { readonly login: string; readonly name: string | null } | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Accounts with a review requested. Team-level requests are excluded by each provider. */
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
}

export interface ProviderChangeRequestPage {
  readonly items: ReadonlyArray<ProviderChangeRequest>;
  /** True when the host has more rows than the page size asked for. */
  readonly truncated: boolean;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<{ readonly login: string; readonly name: string | null }>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commentsTruncated: boolean;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
}

export interface ProviderRepositoryRef {
  readonly cwd: string;
  /** Provider-native repository identity, e.g. `owner/repo` or `group/subgroup/project`. */
  readonly repository: string;
}

/**
 * One host's change requests. Implementations own their own tool and JSON shapes and hand back
 * the neutral types above; anything a host cannot do is declared in `capabilities` rather than
 * failing at call time.
 */
export interface PullRequestProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: PullRequestCapabilities;

  /** The signed-in account, which is what involvement filtering compares against. */
  readonly getViewer: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  /** Only called when `capabilities.diff` is true. */
  readonly getDiff: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<
    { readonly patch: string; readonly truncated: boolean },
    PullRequestProviderError
  >;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, PullRequestProviderError>;
}

export class PullRequestProviderRegistry extends Context.Service<
  PullRequestProviderRegistry,
  {
    /** Null for a host with no implementation, which the service reports as unsupported. */
    readonly get: (kind: SourceControlProviderKind) => PullRequestProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/pullRequest/PullRequestProvider/PullRequestProviderRegistry") {}

export function makeRegistry(
  providers: ReadonlyArray<PullRequestProviderApi>,
): PullRequestProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/** Convenience for implementations: one place that builds their failures. */
export function providerError(
  provider: SourceControlProviderKind,
  operation: string,
  reason: PullRequestProviderError["reason"],
  detail: string,
  cause?: unknown,
): PullRequestProviderError {
  return new PullRequestProviderError({
    provider,
    operation,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}
