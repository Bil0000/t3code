import type { GitHistoryCommit } from "@t3tools/contracts";

import type { GitHistoryGraphRow } from "../../lib/gitHistoryGraph";
export interface GitHistoryRow {
  commit: GitHistoryCommit;
  graph: GitHistoryGraphRow;
}

export type CommitRefKind = "head" | "local" | "remote" | "tag" | "unknown";
