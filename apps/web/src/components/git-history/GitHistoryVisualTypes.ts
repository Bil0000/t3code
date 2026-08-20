import type { GitHistoryCommit } from "@t3tools/contracts";

import type { GitHistoryGraphRow } from "../../lib/gitHistoryGraph";
import type { GitRefTreeNode } from "../../lib/gitRefTree";

export interface RefTreeProps {
  nodes: ReadonlyArray<GitRefTreeNode>;
  namespace: "heads" | "remotes" | "tags";
  section: string;
  depth?: number;
  filterActive: boolean;
  expanded: ReadonlySet<string>;
  selectedRevision: string | null;
  onToggle: (key: string) => void;
  onSelect: (label: string, revision: string) => void;
}

export interface GitHistoryRow {
  commit: GitHistoryCommit;
  graph: GitHistoryGraphRow;
}

export type CommitRefKind = "head" | "local" | "remote" | "tag" | "unknown";
