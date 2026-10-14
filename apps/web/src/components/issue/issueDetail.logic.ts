import type {
  IssueActor,
  IssueAssigneeCandidate,
  IssueLabel,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueRef,
  PullRequestRef,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

export type IssueLinkedPullRequestTarget = Pick<
  PullRequestRef,
  "projectId" | "repository" | "number"
> & {
  host?: string;
  url: string;
};

export const issueAssigneeId = (actor: IssueActor) => actor.id ?? actor.login;

const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function isIssueAssignee(current: ReadonlyArray<IssueActor>, id: string): boolean {
  return current.some((actor) => sameId(issueAssigneeId(actor), id));
}

export function nextIssueAssignees(
  current: ReadonlyArray<IssueActor>,
  candidate: IssueAssigneeCandidate,
  maxAssignees?: number,
): string[] {
  const ids = current.map(issueAssigneeId);
  if (ids.some((id) => sameId(id, candidate.id))) {
    return ids.filter((id) => !sameId(id, candidate.id));
  }
  return maxAssignees === 1 ? [candidate.id] : [...ids, candidate.id];
}

const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  fields.some((field) => (field ?? "").toLowerCase().includes(needle));

export function issueLabelOptions(
  applied: ReadonlyArray<IssueLabel>,
  fetched: ReadonlyArray<IssueLabelCandidate>,
  query: string,
): IssueLabelCandidate[] {
  const missing = applied
    .filter((label) => !fetched.some((candidate) => candidate.name === label.name))
    .map((label) => ({ ...label, description: null }));
  const needle = query.toLowerCase();
  return [...fetched, ...missing].filter((label) => matches(needle, label.name, label.description));
}

export function issueAssigneeOptions(
  current: ReadonlyArray<IssueActor>,
  fetched: ReadonlyArray<IssueAssigneeCandidate>,
  query: string,
): IssueAssigneeCandidate[] {
  const missing = current
    .map((actor) => ({ ...actor, id: issueAssigneeId(actor) }))
    .filter((actor) => !fetched.some((candidate) => sameId(candidate.id, actor.id)));
  const needle = query.toLowerCase();
  return [...fetched, ...missing].filter((candidate) =>
    matches(needle, candidate.login, candidate.name, candidate.id),
  );
}

export function linkedPullRequestTarget(
  link: IssueLinkedPullRequest,
  reference: IssueRef,
): IssueLinkedPullRequestTarget | null {
  const trackerProvider = sourceControlClients.find(reference.tracker)?.kind;
  const provider = link.provider ?? trackerProvider;
  if (provider === undefined) return null;
  const host = link.host ?? (provider === trackerProvider ? reference.host : undefined);
  return {
    projectId: reference.projectId,
    ...(host === undefined ? {} : { host }),
    repository: link.repository,
    number: link.number,
    url: link.url,
  };
}

export function issueDisplayLabel(scope: string, key: string): string {
  if (key.startsWith("#")) return `${scope}${key}`;
  return /^\d+$/.test(key) ? `${scope}#${key}` : key;
}
