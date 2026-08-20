import type { EnvironmentId, VcsHistoryRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildGitRefTree, filterGitRefTree } from "../../lib/gitRefTree";
import { useDebouncedValue, usePaginatedHistoryRefs } from "../../state/queries";

const REF_FILTER_DEBOUNCE_MS = 200;

export interface GitHistoryRevision {
  readonly label: string;
  readonly revision: string;
}

export function useGitHistoryRefs(environmentId: EnvironmentId, cwd: string, revision: number) {
  const [refFilter, setRefFilter] = useState("");
  const [selectedRevisionState, setSelectedRevision] = useState<
    GitHistoryRevision | null | undefined
  >(undefined);
  const [expandedRefKeys, setExpandedRefKeys] = useState<ReadonlySet<string>>(
    () => new Set(["section:local"]),
  );
  const deferredRefFilter = useDebouncedValue(refFilter.trim(), REF_FILTER_DEBOUNCE_MS);
  const normalizedRefFilter = refFilter.trim().toLocaleLowerCase();
  const shouldLoadRemote =
    deferredRefFilter.length > 0 ||
    expandedRefKeys.has("section:remote") ||
    selectedRevisionState?.revision.startsWith("refs/remotes/") === true;
  const shouldLoadTags =
    deferredRefFilter.length > 0 ||
    expandedRefKeys.has("section:tags") ||
    selectedRevisionState?.revision.startsWith("refs/tags/") === true;
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
  const defaultSelectedRevision = useMemo(
    () =>
      currentRef === undefined
        ? refs.error
          ? null
          : undefined
        : currentRef === null
          ? null
          : { label: currentRef.name, revision: `refs/heads/${currentRef.name}` },
    [currentRef, refs.error],
  );
  const selectedRefWasRemoved = useMemo(() => {
    if (selectedRevisionState === undefined || selectedRevisionState === null) return false;
    if (deferredRefFilter.length > 0) return false;
    const selectedRef = selectedRevisionState.revision;
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
    selectedRevisionState,
    tagRefs,
    tags.data?.isComplete,
    tags.data?.nextCursor,
  ]);
  const selectedRevision =
    selectedRevisionState === undefined || selectedRefWasRemoved
      ? defaultSelectedRevision
      : selectedRevisionState;
  const toggleRefKey = useCallback((key: string) => {
    setExpandedRefKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectRef = useCallback((label: string, revision: string) => {
    setSelectedRevision({ label, revision });
  }, []);
  const selectAllRefs = useCallback(() => {
    setSelectedRevision(null);
  }, []);

  useEffect(() => {
    setSelectedRevision(undefined);
    setRefFilter("");
    setExpandedRefKeys(new Set(["section:local"]));
  }, [cwd, environmentId]);

  useEffect(() => {
    if (selectedRefWasRemoved) setSelectedRevision(undefined);
  }, [selectedRefWasRemoved]);

  return {
    currentRef,
    expandedRefKeys,
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
  };
}
