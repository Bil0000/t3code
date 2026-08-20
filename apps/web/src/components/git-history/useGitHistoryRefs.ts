import type { EnvironmentId, VcsHistoryRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  const shouldLoadLocal = deferredRefFilter.length > 0 || expandedRefKeys.has("section:local");
  const shouldLoadRemote = deferredRefFilter.length > 0 || expandedRefKeys.has("section:remote");
  const shouldLoadTags = deferredRefFilter.length > 0 || expandedRefKeys.has("section:tags");
  const refs = usePaginatedHistoryRefs(
    shouldLoadLocal
      ? { environmentId, cwd, query: deferredRefFilter }
      : { environmentId: null, cwd: null },
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
  const currentRef = refs.data?.currentRef;
  const selectedRevision = useMemo(
    () =>
      selectedRevisionState === undefined
        ? currentRef === undefined
          ? undefined
          : currentRef === null
            ? null
            : { label: currentRef.name, revision: `refs/heads/${currentRef.name}` }
        : selectedRevisionState,
    [currentRef, selectedRevisionState],
  );
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

  return {
    currentRef,
    expandedRefKeys,
    hasMoreRefs:
      (shouldLoadLocal && refs.data?.nextCursor !== null && refs.data?.nextCursor !== undefined) ||
      (shouldLoadRemote &&
        remote.data?.nextCursor !== null &&
        remote.data?.nextCursor !== undefined) ||
      (shouldLoadTags && tags.data?.nextCursor !== null && tags.data?.nextCursor !== undefined),
    isFetchingMoreRefs:
      (shouldLoadLocal && refs.isFetchingNextPage) ||
      (shouldLoadRemote && remote.isFetchingNextPage) ||
      (shouldLoadTags && tags.isFetchingNextPage),
    isRefSnapshotComplete:
      (!shouldLoadLocal || refs.data?.isComplete !== false) &&
      (!shouldLoadRemote || remote.data?.isComplete !== false) &&
      (!shouldLoadTags || tags.data?.isComplete !== false),
    localRefTree,
    localRefs,
    normalizedRefFilter,
    onLoadMoreRefs: () => {
      if (shouldLoadLocal) refs.loadNext();
      if (shouldLoadRemote) remote.loadNext();
      if (shouldLoadTags) tags.loadNext();
    },
    refreshRefs: () => {
      refs.refresh();
    },
    onRetryRefs: () => {
      if (shouldLoadLocal && refs.error) refs.retry();
      if (shouldLoadRemote && remote.error) remote.retry();
      if (shouldLoadTags && tags.error) tags.retry();
    },
    refPaginationError:
      (shouldLoadLocal ? refs.error : null) ??
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
