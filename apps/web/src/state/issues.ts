import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueListResult, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useState } from "react";

import { useIssueViewRefresh } from "../hooks/useIssueViewRefresh";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { EnvironmentQueryTarget } from "./pullRequests";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export interface MergedIssueListView {
  /** One answer per environment that has one, in target order. */
  readonly answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>;
  /** The first environment that failed outright; the others may still have answered. */
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/**
 * The same listing read across every connected environment at once, as the pull-request page
 * does: React cannot subscribe to a list of atoms whose length changes, so the fan-out lives in
 * one derived atom keyed by the targets. An environment that fails contributes nothing rather
 * than blanking the page.
 */
const mergedIssueListFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
    const answers: Array<readonly [EnvironmentId, IssueListResult]> = [];
    let error: string | null = null;
    let isPending = false;
    for (const target of targets) {
      const result = get(issueEnvironment.list(target));
      isPending ||= result.waiting;
      if (result._tag === "Failure" && error === null) {
        error = formatEnvironmentQueryError(result.cause);
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) answers.push([target.environmentId, value]);
    }
    return { answers, error, isPending };
  }).pipe(Atom.withLabel(`web-issues:list:${key}`)),
);

const EMPTY_ISSUE_LIST = Atom.make({
  answers: [] as ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  error: null as string | null,
  isPending: false,
}).pipe(Atom.withLabel("web-issues:list:empty"));

export function useIssueList(targets: ReadonlyArray<IssueListTarget>): MergedIssueListView {
  const key = JSON.stringify(targets);
  const view = useAtomValue(targets.length === 0 ? EMPTY_ISSUE_LIST : mergedIssueListFamily(key));
  const refresh = useCallback(() => {
    for (const target of JSON.parse(key) as ReadonlyArray<IssueListTarget>) {
      appAtomRegistry.refresh(issueEnvironment.list(target));
    }
  }, [key]);
  return { ...view, refresh };
}

interface IssueQueryAnswer<A> {
  readonly value: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

const EMPTY_ANSWERS = Atom.make<ReadonlyArray<IssueQueryAnswer<never>>>([]).pipe(
  Atom.withLabel("web-issues:answers:empty"),
);

function createIssueQueries<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get) =>
      (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>).map(
        (target): IssueQueryAnswer<A> => {
          const result = get(atomFor(target));
          return {
            value: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isPending: result.waiting || result._tag === "Initial",
          };
        },
      ),
    ).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  return function useIssueQueries(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const answers = useAtomValue(
      targets.length === 0
        ? (EMPTY_ANSWERS as unknown as Atom.Atom<ReadonlyArray<IssueQueryAnswer<A>>>)
        : family(key),
    );
    const refresh = useCallback(() => {
      for (const target of JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>) {
        appAtomRegistry.refresh(atomFor(target));
      }
    }, [key]);
    return { answers, refresh };
  };
}

export interface IssuePagedView<T> {
  readonly items: ReadonlyArray<T>;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly refresh: () => void;
}

function createIssuePagedQuery<
  Input extends {
    readonly cursor?: string | undefined;
    readonly projectId?: ProjectId | undefined;
  },
  A,
  T,
  Extra = undefined,
>(
  label: string,
  family: (target: EnvironmentQueryTarget<Input>) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  page: (value: A) => {
    readonly items: ReadonlyArray<T>;
    readonly nextCursor: string | null;
    readonly truncated?: boolean | undefined;
  },
  extra: (first: A | null) => Extra = () => undefined as Extra,
) {
  const useQueries = createIssueQueries(label, family);
  return function useIssuePages(
    environmentId: EnvironmentId | null,
    input: Input | null,
  ): IssuePagedView<T> & { readonly extra: Extra } {
    const key =
      environmentId === null || input === null ? "" : JSON.stringify([environmentId, input]);
    const [cursors, setCursors] = useState<{
      key: string;
      seed: A | null;
      values: ReadonlyArray<string>;
    }>({
      key,
      seed: null,
      values: [],
    });
    const values = cursors.key === key ? cursors.values : [];
    const { answers, refresh } = useQueries(
      environmentId === null || input === null
        ? []
        : [undefined, ...values].map((cursor) => ({
            environmentId,
            input: cursor === undefined ? input : { ...input, cursor },
          })),
    );
    useIssueViewRefresh(
      refresh,
      environmentId === null || input === null ? [] : [{ environmentId, input }],
      key,
    );
    const first = answers[0]?.value ?? null;
    const retained = cursors.seed === first;
    if (values.length > 0 && !retained) setCursors({ key, seed: first, values: [] });
    const activeAnswers = retained ? answers : answers.slice(0, 1);
    const pages = activeAnswers.map((answer) =>
      answer.value === null ? null : page(answer.value),
    );
    const last = activeAnswers.at(-1);
    const nextCursor = pages.at(-1)?.nextCursor ?? null;
    const failedCursor =
      last?.error !== null && last?.error !== undefined ? values.at(-1) : undefined;
    return {
      items: pages.flatMap((entry) => entry?.items ?? []),
      truncated: pages.some((entry) => entry?.truncated === true),
      hasMore: failedCursor !== undefined || (nextCursor !== null && !values.includes(nextCursor)),
      isPending: activeAnswers.some((answer) => answer.isPending),
      error: activeAnswers.find((answer) => answer.error !== null)?.error ?? null,
      extra: extra(answers[0]?.value ?? null),
      loadMore: () => {
        if (last?.isPending) return;
        if (failedCursor !== undefined && environmentId !== null && input !== null) {
          appAtomRegistry.refresh(
            family({ environmentId, input: { ...input, cursor: failedCursor } }),
          );
          return;
        }
        if (nextCursor === null || values.includes(nextCursor) || last?.isPending) return;
        setCursors({ key, seed: first, values: [...values, nextCursor] });
      },
      refresh,
    };
  };
}

const pageOf = <P>(value: P) => value;

export const useIssueHistory = createIssuePagedQuery(
  "web-issues:history",
  issueEnvironment.history,
  pageOf,
);
export const useIssueLinkedPullRequests = createIssuePagedQuery(
  "web-issues:linked-pull-requests",
  issueEnvironment.linkedPullRequests,
  pageOf,
);
export const useIssueHierarchy = createIssuePagedQuery(
  "web-issues:hierarchy",
  issueEnvironment.hierarchy,
  (value) => value.children,
  (first) => first?.parent ?? null,
);
export const useIssueLabelCandidates = createIssuePagedQuery(
  "web-issues:label-candidates",
  issueEnvironment.labelCandidates,
  pageOf,
);
export const useIssueAssigneeCandidates = createIssuePagedQuery(
  "web-issues:assignee-candidates",
  issueEnvironment.assigneeCandidates,
  pageOf,
);
