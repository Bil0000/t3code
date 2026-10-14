import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type { IssueDetail, IssueLabel } from "@t3tools/contracts";
import { issueAssigneeId } from "./issueDetail";

type IssuePickerKind = "labels" | "assignees";

export type IssuePickerConfirmed = {
  readonly base: IssueDetail;
  readonly environmentId: string;
  readonly kind: IssuePickerKind;
  readonly ids: ReadonlyArray<string>;
};

export const issueLabelId = (label: IssueLabel) => label.id ?? label.name;

const nativeIssuePickerIds = (issue: IssueDetail, kind: IssuePickerKind) =>
  kind === "labels" ? issue.labels.map(issueLabelId) : issue.assignees.map(issueAssigneeId);

export function heldIssuePicker(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): IssuePickerConfirmed | null {
  if (
    !confirmed ||
    confirmed.environmentId !== environmentId ||
    confirmed.kind !== kind ||
    confirmed.base.tracker !== issue.tracker ||
    issueEntryKey(confirmed.base) !== issueEntryKey(issue)
  )
    return null;
  const native = nativeIssuePickerIds(issue, kind);
  const same = (id: string, other: string) =>
    kind === "labels" ? id === other : id.toLowerCase() === other.toLowerCase();
  const acknowledged =
    confirmed.base !== issue &&
    native.length === confirmed.ids.length &&
    native.every((id) => confirmed.ids.some((other) => same(id, other)));
  return acknowledged ? null : confirmed;
}

export function issuePickerIds(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): ReadonlyArray<string> {
  return (
    heldIssuePicker(issue, kind, confirmed, environmentId)?.ids ?? nativeIssuePickerIds(issue, kind)
  );
}

export function nextIssuePickerIds(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  id: string,
  environmentId: string,
): string[] {
  const current = issuePickerIds(issue, kind, confirmed, environmentId);
  const same = (each: string) =>
    kind === "labels" ? each === id : each.toLowerCase() === id.toLowerCase();
  if (current.some(same)) return current.filter((each) => !same(each));
  return kind === "assignees" && issue.capabilities.maxAssignees === 1 ? [id] : [...current, id];
}
