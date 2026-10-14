import {
  WS_METHODS,
  issueListCursorKey,
  threadIssueKeyOf,
  type EnvironmentId,
  type IssueCapabilities,
  type IssueComment,
  type IssueInvolvement,
  type IssueListCursors,
  type IssueListEntry,
  type IssueListResult,
  type IssueRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  executeAtomQuery,
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createIssueSourceRefreshQueue() {
  const lanes = new Map<string, { next: (() => Promise<void>) | null; task: Promise<void> }>();
  return (key: string, read: () => Promise<void>) => {
    const previous = lanes.get(key);
    if (previous) {
      previous.next = read;
      return previous.task;
    }
    const lane = { next: read as (() => Promise<void>) | null, task: Promise.resolve() };
    lane.task = Promise.resolve().then(async () => {
      try {
        while (lane.next) {
          const next = lane.next;
          lane.next = null;
          await next();
        }
      } finally {
        lanes.delete(key);
      }
    });
    lanes.set(key, lane);
    return lane.task;
  };
}

export async function readIssueListSourcePage<Q, E>(
  registry: AtomRegistry.AtomRegistry,
  query: Atom.Atom<AsyncResult.AsyncResult<IssueListResult, Q>>,
  read: () => Promise<AtomCommandResult<IssueListResult, E>>,
) {
  if (registry.get(query).waiting)
    await executeAtomQuery(registry, query, { reportFailure: false });
  const answer = Option.getOrNull(AsyncResult.value(registry.get(query)));
  const result = await read();
  return {
    answer,
    result,
    isCurrent: () => {
      const latest = registry.get(query);
      return !latest.waiting && Option.getOrNull(AsyncResult.value(latest)) === answer;
    },
  };
}

/** One row's identity across list pages and detail reads; hosts compare case-insensitively. */
export function issueEntryKey(
  entry: Pick<IssueListEntry, "projectId" | "host" | "scope" | "key"> & {
    readonly tracker: string;
  },
): string {
  return `${entry.projectId}\u0000${threadIssueKeyOf(entry)}`;
}

/**
 * Lay a continuation page over the rows already held. A page only covers the scopes it was asked
 * to continue, so rows from other scopes stay; a row the page repeats replaces the held one, so a
 * title or state that moved between reads shows the newer words. Order stays newest-updated first,
 * which is how every tracker hands them over.
 */
export function mergeIssueListPage(
  held: ReadonlyArray<IssueListEntry>,
  page: ReadonlyArray<IssueListEntry>,
): ReadonlyArray<IssueListEntry> {
  if (held.length === 0) return page;
  if (page.length === 0) return held;
  const byKey = new Map<string, IssueListEntry>();
  for (const entry of held) byKey.set(issueEntryKey(entry), entry);
  for (const entry of page) byKey.set(issueEntryKey(entry), entry);
  return [...byKey.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function issueListCursorsOn(
  cursors: IssueListCursors,
  host: string,
  tracker?: string,
): IssueListCursors {
  const prefix = `${host.toLowerCase()} `;
  return Object.fromEntries(
    Object.entries(cursors).filter(([key]) => {
      const normalized = key.toLowerCase();
      if (normalized.startsWith(prefix)) return true;
      const [kind, ...rest] = normalized.split(" ");
      return (tracker === undefined || kind === tracker) && rest.join(" ").startsWith(prefix);
    }),
  );
}

type IssueListPage = Pick<IssueListResult, "entries" | "nextCursors" | "errors"> & {
  readonly sources?: IssueListResult["sources"];
};
type HeldIssueList = IssueListPage & {
  readonly firstCursors: IssueListCursors;
  readonly firstKeys: ReadonlySet<string>;
};

type IssueListSource = {
  readonly projectId: string;
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
};

const scopeOf = (source: IssueListSource, cursors: ReadonlySet<string>) => {
  const qualified = issueListCursorKey(source).toLowerCase();
  const legacy = `${source.host} ${source.scope}`.toLowerCase();
  return cursors.has(qualified) || !cursors.has(legacy) ? qualified : legacy;
};

const heldSources = (held: HeldIssueList) => held.sources ?? held.entries;
const matchesSource = (error: IssueListPage["errors"][number], source: IssueListSource) =>
  error.projectId === source.projectId &&
  (error.host === undefined || error.host.toLowerCase() === source.host.toLowerCase()) &&
  (error.tracker === undefined || error.tracker === source.tracker);

function failedScopes(
  pool: ReadonlyArray<IssueListSource>,
  errors: IssueListPage["errors"],
  cursors: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    pool
      .filter((source) => errors.some((error) => matchesSource(error, source)))
      .map((source) => scopeOf(source, cursors)),
  );
}

export function continueIssueListPage<T extends HeldIssueList>(
  held: T,
  sent: IssueListCursors,
  page: IssueListPage,
  sentFirstCursors: IssueListCursors,
): T {
  if (
    held.firstCursors !== sentFirstCursors ||
    Object.entries(sent).some(([key, cursor]) => held.nextCursors[key] !== cursor)
  ) {
    return held;
  }
  const sentScopes = new Set(Object.keys(sent).map((key) => key.toLowerCase()));
  const cursors = new Set(Object.keys(held.nextCursors).map((key) => key.toLowerCase()));
  const retried = heldSources(held).filter((source) => sentScopes.has(scopeOf(source, cursors)));
  const failed = failedScopes(heldSources(held), page.errors, cursors);
  const kept = Object.entries(held.nextCursors).filter(
    ([key]) => sent[key] === undefined || failed.has(key.toLowerCase()),
  );
  return {
    ...held,
    entries: mergeIssueListPage(held.entries, page.entries),
    nextCursors: { ...Object.fromEntries(kept), ...page.nextCursors },
    errors: [
      ...held.errors.filter((error) => !retried.some((source) => matchesSource(error, source))),
      ...page.errors,
    ],
  };
}

export function refreshIssueListPage<T extends HeldIssueList>(
  held: T,
  fresh: IssueListPage,
  options: {
    readonly source?: IssueListSource;
    readonly removed?: string | ReadonlySet<string>;
  } = {},
): T {
  const { source } = options;
  const cursors = new Set(
    [
      ...Object.keys(held.firstCursors),
      ...Object.keys(held.nextCursors),
      ...Object.keys(fresh.nextCursors),
    ].map((key) => key.toLowerCase()),
  );
  const failed = failedScopes(
    [...(fresh.sources ?? []), ...heldSources(held)],
    fresh.errors,
    cursors,
  );
  const covered = (key: string) =>
    !failed.has(key.toLowerCase()) &&
    (source === undefined || key.toLowerCase() === scopeOf(source, cursors));
  const continued = (key: string) => held.nextCursors[key] !== held.firstCursors[key];
  const keys = new Set([...Object.keys(held.firstCursors), ...Object.keys(held.nextCursors)]);
  const tails = new Set([...keys].filter(continued).map((key) => key.toLowerCase()));
  const bound =
    source === undefined && fresh.sources !== undefined
      ? new Set(fresh.sources.map((each) => scopeOf(each, cursors)))
      : null;
  const isBound = (key: string) => bound === null || bound.has(key.toLowerCase());
  const taken = fresh.entries.filter((entry) => covered(scopeOf(entry, cursors)));
  const freshKeys = new Set(taken.map(issueEntryKey));
  const representatives = new Map<string, string>();
  for (const representative of [...taken, ...(fresh.sources ?? [])]) {
    const scope = scopeOf(representative, cursors);
    if (!representatives.has(scope)) representatives.set(scope, representative.projectId);
  }
  const changedOwners = new Set(
    held.entries
      .filter((entry) => {
        const scope = scopeOf(entry, cursors);
        const owner = representatives.get(scope);
        return covered(scope) && owner !== undefined && owner !== entry.projectId;
      })
      .map((entry) => scopeOf(entry, cursors)),
  );
  const shifted = new Set(
    [...held.entries.filter((entry) => held.firstKeys.has(issueEntryKey(entry))), ...taken]
      .filter((row) => held.firstKeys.has(issueEntryKey(row)) !== freshKeys.has(issueEntryKey(row)))
      .map((row) => scopeOf(row, cursors)),
  );
  const continuing = new Set(Object.keys(fresh.nextCursors).map((key) => key.toLowerCase()));
  const keep = (key: string) =>
    isBound(key) &&
    (!covered(key) ||
      (continuing.has(key.toLowerCase()) &&
        tails.has(key.toLowerCase()) &&
        !shifted.has(key.toLowerCase()) &&
        !changedOwners.has(key.toLowerCase())));
  const pick = (cursors: IssueListCursors, take: (key: string) => boolean) =>
    Object.fromEntries(Object.entries(cursors).filter(([key]) => take(key)));
  const kept = held.entries.filter((entry) => {
    const scope = scopeOf(entry, cursors);
    const key = issueEntryKey(entry);
    return (
      isBound(scope) &&
      (!covered(scope) ||
        (continuing.has(scope) &&
          !changedOwners.has(scope) &&
          !held.firstKeys.has(key) &&
          (typeof options.removed === "string"
            ? key !== options.removed
            : !options.removed?.has(key))))
    );
  });
  return {
    ...held,
    entries: mergeIssueListPage(kept, taken),
    firstKeys: new Set([
      ...kept.map(issueEntryKey).filter((key) => held.firstKeys.has(key)),
      ...taken.map(issueEntryKey),
    ]),
    nextCursors: {
      ...pick(held.nextCursors, keep),
      ...pick(fresh.nextCursors, (key) => !keep(key)),
    },
    firstCursors: {
      ...pick(held.firstCursors, (key) => isBound(key) && !covered(key)),
      ...pick(fresh.nextCursors, covered),
    },
    sources: source === undefined ? (fresh.sources ?? held.sources) : held.sources,
    errors: [
      ...(source === undefined ? [] : held.errors.filter((error) => !matchesSource(error, source))),
      ...fresh.errors,
    ],
  };
}

export function issueScopeKey(
  environmentId: EnvironmentId,
  scope: { readonly tracker: string; readonly host: string; readonly scope: string },
): string {
  return JSON.stringify([
    environmentId,
    scope.tracker,
    scope.host.toLowerCase(),
    scope.scope.toLowerCase(),
  ]);
}

export function offeredIssueInvolvements(
  trackers: ReadonlyArray<{ readonly capabilities: IssueCapabilities | null }>,
  active: IssueInvolvement,
): ReadonlySet<IssueInvolvement> | null {
  const offered = new Set<IssueInvolvement>([active]);
  let declared = false;
  for (const { capabilities } of trackers) {
    if (capabilities === null) continue;
    if (capabilities.involvements === undefined) return null;
    declared = true;
    for (const involvement of capabilities.involvements) offered.add(involvement);
  }
  return declared ? offered : null;
}

/** Older comments go in front: the detail carries the newest page and pages walk backwards. */
export function prependIssueComments(
  current: ReadonlyArray<IssueComment>,
  older: ReadonlyArray<IssueComment>,
): ReadonlyArray<IssueComment> {
  if (older.length === 0) return current;
  const seen = new Set(current.map((comment) => comment.id));
  return [...older.filter((comment) => !seen.has(comment.id)), ...current];
}

/**
 * Every read goes to a tracker API over the environment, so results are reused for a short while
 * and refreshed explicitly. Mutations run serially per environment: changes to one issue are
 * order-sensitive. Each confirmed write refreshes the detail it touched; the list is refreshed by
 * the page, which knows which listings it is showing.
 */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 30_000,
  });
  const detailRef = ({ projectId, tracker, host, scope, key }: IssueRef): IssueRef => ({
    projectId,
    tracker,
    ...(host === undefined ? {} : { host }),
    scope,
    key,
  });
  const refreshDetail = (
    { environmentId, input }: { readonly environmentId: EnvironmentId; readonly input: IssueRef },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(detail({ environmentId, input: detailRef(input) })));
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
    /**
     * A continuation of the listing, run as a command rather than read as a query: a page is
     * asked for once and laid over the rows held, and a refresh of the first page forgets it.
     */
    listPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:list-page",
      tag: WS_METHODS.issuesList,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => `issues-list-page ${environmentId}`,
      },
    }),
    detail,
    resolveUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:resolve-url",
      tag: WS_METHODS.issuesResolveUrl,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    /** Older comments past the cursor the detail handed over; the panel prepends what arrives. */
    comments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comments",
      tag: WS_METHODS.issuesComments,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    /** Read when the composer opens: what a scope offers a new issue changes with a commit. */
    templates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:templates",
      tag: WS_METHODS.issuesTemplates,
      staleTimeMs: 5 * 60_000,
    }),
    /** Read when a label or assignee picker opens, not with every issue. */
    candidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:candidates",
      tag: WS_METHODS.issuesCandidates,
      staleTimeMs: 60_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:create",
      tag: WS_METHODS.issuesCreate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comment",
      tag: WS_METHODS.issuesComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:update",
      tag: WS_METHODS.issuesUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.issuesSetState,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    react: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:react",
      tag: WS_METHODS.issuesReact,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
  };
}

export type IssueListAnswer = IssueListResult;
