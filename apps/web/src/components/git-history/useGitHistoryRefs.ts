import type { EnvironmentId, VcsHistoryRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { buildGitRefTree, filterGitRefTree } from "../../lib/gitRefTree";
import { useDebouncedValue, usePaginatedHistoryRefs } from "../../state/queries";

const EMPTY_FAVORITE_BRANCHES: ReadonlyArray<string> = [];
const FavoriteBranchesSchema = Schema.Array(Schema.String);
const REF_FILTER_DEBOUNCE_MS = 175;

export interface GitHistoryRevision {
  readonly label: string;
  readonly revision: string;
}

export function gitHistoryFavoriteStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `t3code:git-history-favorites:v1:${environmentId}:${cwd}`;
}

export function toggleGitHistoryFavorite(
  favorites: ReadonlyArray<string>,
  branch: string,
): ReadonlyArray<string> {
  return favorites.includes(branch)
    ? favorites.filter((value) => value !== branch)
    : [...favorites, branch];
}

export function useGitHistoryRefs(environmentId: EnvironmentId, cwd: string, revision: number) {
  const scopeKey = JSON.stringify([environmentId, cwd]);
  const [favoriteBranches, setFavoriteBranches] = useLocalStorage(
    gitHistoryFavoriteStorageKey(environmentId, cwd),
    EMPTY_FAVORITE_BRANCHES,
    FavoriteBranchesSchema,
  );
  const [refFilter, setRefFilter] = useState("");
  const [selectedRevisionState, setSelectedRevision] = useState<{
    readonly scopeKey: string;
    readonly value: GitHistoryRevision | null | undefined;
  }>(() => ({ scopeKey, value: undefined }));
  const scopedSelectedRevision =
    selectedRevisionState.scopeKey === scopeKey ? selectedRevisionState.value : undefined;
  const [expandedRefKeys, setExpandedRefKeys] = useState<ReadonlySet<string>>(
    () => new Set(["section:local"]),
  );
  const deferredRefFilter = useDebouncedValue(refFilter.trim(), REF_FILTER_DEBOUNCE_MS);
  const normalizedRefFilter = refFilter.trim().toLocaleLowerCase();
  const shouldLoadRemote =
    deferredRefFilter.length > 0 ||
    expandedRefKeys.has("section:remote") ||
    scopedSelectedRevision?.revision.startsWith("refs/remotes/") === true;
  const shouldLoadTags =
    deferredRefFilter.length > 0 ||
    expandedRefKeys.has("section:tags") ||
    scopedSelectedRevision?.revision.startsWith("refs/tags/") === true;
  const refs = usePaginatedHistoryRefs(
    { environmentId, cwd, query: deferredRefFilter },
    { limit: 200, namespace: "local", revision },
  );
  const remote = usePaginatedHistoryRefs(
    shouldLoadRemote
      ? { environmentId, cwd, query: deferredRefFilter }
      : { environmentId: null, cwd: null },
    { limit: 200, namespace: "remote", revision },
  );
  const tags = usePaginatedHistoryRefs(
    shouldLoadTags
      ? { environmentId, cwd, query: deferredRefFilter }
      : { environmentId: null, cwd: null },
    { limit: 200, namespace: "tag", revision },
  );
  const mergedRefs = useMemo(() => [...refs.refs, ...remote.refs], [refs.refs, remote.refs]);
  const tagRefs = tags.refs;
  const { localRefs, remoteRefs } = useMemo(() => {
    const local: VcsHistoryRef[] = [];
    const remote: VcsHistoryRef[] = [];
    for (const ref of mergedRefs) {
      if (ref.isRemote) remote.push(ref);
      else if (!ref.isTag) local.push(ref);
    }
    return { localRefs: local, remoteRefs: remote };
  }, [mergedRefs]);
  const localRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(localRefs), normalizedRefFilter),
    [localRefs, normalizedRefFilter],
  );
  const favoriteBranchSet = useMemo(() => new Set(favoriteBranches), [favoriteBranches]);
  const favoriteRefs = useMemo(
    () =>
      localRefs.filter(
        (ref) =>
          favoriteBranchSet.has(ref.name) &&
          (normalizedRefFilter.length === 0 ||
            ref.name.toLocaleLowerCase().includes(normalizedRefFilter)),
      ),
    [favoriteBranchSet, localRefs, normalizedRefFilter],
  );
  const remoteRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(remoteRefs), normalizedRefFilter),
    [normalizedRefFilter, remoteRefs],
  );
  const tagRefTree = useMemo(
    () => filterGitRefTree(buildGitRefTree(tagRefs), normalizedRefFilter),
    [normalizedRefFilter, tagRefs],
  );
  const currentRefResult = refs.data?.currentRef;
  const currentRefTargetKey = `${environmentId}:${cwd}`;
  const lastResolvedCurrentRef = useRef<
    | {
        readonly targetKey: string;
        currentRef: VcsHistoryRef | null | undefined;
      }
    | undefined
  >(undefined);
  if (lastResolvedCurrentRef.current?.targetKey !== currentRefTargetKey) {
    lastResolvedCurrentRef.current = { targetKey: currentRefTargetKey, currentRef: undefined };
  }
  if (currentRefResult !== undefined) lastResolvedCurrentRef.current.currentRef = currentRefResult;
  const currentRef =
    currentRefResult === undefined ? lastResolvedCurrentRef.current.currentRef : currentRefResult;
  const defaultSelectedRevision = useMemo(() => {
    if (currentRef === undefined) return refs.error === null ? undefined : null;
    if (currentRef === null) return null;
    return { label: currentRef.name, revision: `refs/heads/${currentRef.name}` };
  }, [currentRef, refs.error]);
  const selectedRefWasRemoved = useMemo(() => {
    if (scopedSelectedRevision === undefined || scopedSelectedRevision === null) return false;
    if (deferredRefFilter.length > 0) return false;
    const selectedRef = scopedSelectedRevision.revision;
    if (selectedRef.startsWith("refs/heads/")) {
      return (
        refs.data?.isComplete === true &&
        refs.data.nextCursor === null &&
        !localRefs.some((ref) => selectedRef === `refs/heads/${ref.name}`)
      );
    }
    if (selectedRef.startsWith("refs/remotes/")) {
      return (
        remote.data?.isComplete === true &&
        remote.data.nextCursor === null &&
        !remoteRefs.some((ref) => selectedRef === `refs/remotes/${ref.name}`)
      );
    }
    if (selectedRef.startsWith("refs/tags/")) {
      return (
        tags.data?.isComplete === true &&
        tags.data.nextCursor === null &&
        !tagRefs.some((ref) => selectedRef === `refs/tags/${ref.name}`)
      );
    }
    return false;
  }, [
    localRefs,
    deferredRefFilter,
    refs.data?.isComplete,
    refs.data?.nextCursor,
    remote.data?.isComplete,
    remote.data?.nextCursor,
    remoteRefs,
    scopedSelectedRevision,
    tagRefs,
    tags.data?.isComplete,
    tags.data?.nextCursor,
  ]);
  const selectedRevision =
    scopedSelectedRevision === undefined || selectedRefWasRemoved
      ? defaultSelectedRevision
      : scopedSelectedRevision;
  const initialLocalRefError =
    currentRef === undefined && scopedSelectedRevision === undefined ? refs.error : null;
  const toggleRefKey = useCallback((key: string) => {
    setExpandedRefKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectRef = useCallback(
    (label: string, revision: string) => {
      setSelectedRevision({ scopeKey, value: { label, revision } });
    },
    [scopeKey],
  );
  const selectAllRefs = useCallback(() => {
    setSelectedRevision({ scopeKey, value: null });
  }, [scopeKey]);
  const toggleFavorite = useCallback(
    (branch: string) => {
      setFavoriteBranches((current) => toggleGitHistoryFavorite(current, branch));
    },
    [setFavoriteBranches],
  );

  useEffect(() => {
    setSelectedRevision({ scopeKey, value: undefined });
    setRefFilter("");
    setExpandedRefKeys(new Set(["section:local"]));
  }, [cwd, environmentId, scopeKey]);

  useEffect(() => {
    if (selectedRefWasRemoved) setSelectedRevision({ scopeKey, value: undefined });
  }, [scopeKey, selectedRefWasRemoved]);

  return {
    currentRef,
    expandedRefKeys,
    favoriteBranches: favoriteBranchSet,
    favoriteRefs,
    hasMoreRefs:
      (refs.data?.nextCursor !== null && refs.data?.nextCursor !== undefined) ||
      (shouldLoadRemote &&
        remote.data?.nextCursor !== null &&
        remote.data?.nextCursor !== undefined) ||
      (shouldLoadTags && tags.data?.nextCursor !== null && tags.data?.nextCursor !== undefined),
    isFetchingMoreRefs:
      refs.isFetchingNextPage ||
      (shouldLoadRemote && remote.isFetchingNextPage) ||
      (shouldLoadTags && tags.isFetchingNextPage),
    isRefSnapshotComplete:
      refs.data?.isComplete !== false &&
      (!shouldLoadRemote || remote.data?.isComplete !== false) &&
      (!shouldLoadTags || tags.data?.isComplete !== false),
    initialLocalRefError,
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs: () => {
      refs.loadNext();
      if (shouldLoadRemote) remote.loadNext();
      if (shouldLoadTags) tags.loadNext();
    },
    refreshRefs: () => {
      refs.refresh();
      remote.refresh();
      tags.refresh();
    },
    onRetryRefs: () => {
      if (refs.error) refs.retry();
      if (shouldLoadRemote && remote.error) remote.retry();
      if (shouldLoadTags && tags.error) tags.retry();
    },
    refPaginationError:
      refs.error ??
      (shouldLoadRemote ? remote.error : null) ??
      (shouldLoadTags ? tags.error : null),
    refFilter,
    remoteRefTree,
    remoteRefs,
    selectAllRefs,
    selectRef,
    selectedRevision,
    setRefFilter,
    tagRefTree,
    tagRefs,
    toggleRefKey,
    toggleFavorite,
  };
}
