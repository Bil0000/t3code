import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueCreateResult,
  IssueLabel,
  IssueScopeRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import {
  composeTemplateBody,
  initialTemplateValues,
  missingRequiredTemplateFields,
  type IssueTemplateValues,
} from "./issueCreate.logic";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import { issueAssigneeId } from "./issueDetail.logic";
import { IssueTemplateForm } from "./IssueTemplateForm";
import { issueCreateBlocked, resolveIssueType } from "./IssueCreateDialog.logic";

export interface IssueCreateScope {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly scope: IssueScopeRef;
  readonly templates: boolean;
  readonly labels?: boolean | undefined;
  readonly assignees?: boolean | undefined;
  readonly maxAssignees?: number | undefined;
  readonly createIssueTypes?: boolean | undefined;
}

const BLANK = "__blank__";

/**
 * One text box with a draft in it, on any tracker: a chosen template fills the title, body,
 * labels and assignees, and the writer takes it from there. Templates are read when the dialog
 * opens, for the scope it opens on.
 */
export function IssueCreateDialog({
  open,
  scopes,
  onOpenChange,
  onCreated,
  parent,
}: {
  open: boolean;
  parent?: { key: string; displayKey: string } | null;
  /** Every writable scope the page knows about; the first is preselected. */
  scopes: ReadonlyArray<IssueCreateScope>;
  onOpenChange: (open: boolean) => void;
  onCreated: (scope: IssueCreateScope, result: IssueCreateResult) => void;
}) {
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)] ?? null;
  const [templateKey, setTemplateKey] = useState<string>(BLANK);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [values, setValues] = useState<IssueTemplateValues>({});
  const [extras, setExtras] = useState<{
    labels: ReadonlyArray<IssueLabel>;
    assignees: ReadonlyArray<string>;
  }>({
    labels: [],
    assignees: [],
  });
  const [issueType, setIssueType] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const canWrite = useAtomValue(
    issueEnvironment.create.permissionAtom(scope?.environmentId ?? null),
  );
  const templatesQuery = useEnvironmentQuery(
    open && scope !== null && scope.templates
      ? issueEnvironment.templates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const templates = templatesQuery.data?.templates ?? [];
  const externalTemplates = templatesQuery.data?.externalTemplates ?? [];
  const selectedTemplate = templates.find((template) => template.key === templateKey);
  const fields = selectedTemplate?.fields ?? [];
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;
  const candidatesQuery = useEnvironmentQuery(
    open && scope !== null && scope.createIssueTypes === true
      ? issueEnvironment.candidates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const issueTypes = candidatesQuery.data?.issueTypes ?? [];
  const chosenIssueType = resolveIssueType(issueTypes, issueType);

  const reset = () => {
    setTemplateKey(BLANK);
    setTitle("");
    setBody("");
    setExtras({ labels: [], assignees: [] });
    setIssueType(null);
    setValues({});
  };

  const chooseTemplate = (key: string | null) => {
    const next = key ?? BLANK;
    setTemplateKey(next);
    const template = templates.find((entry) => entry.key === next);
    setValues(initialTemplateValues(template?.fields ?? []));
    if (!template) {
      setExtras({ labels: [], assignees: [] });
      return;
    }
    // A template is a starting point: it only overwrites what the writer has not typed yet.
    if (title.trim().length === 0) setTitle(template.title);
    if (body.trim().length === 0) setBody(template.body);
    setExtras({
      labels: template.labels.map((name) => ({ name, color: null })),
      assignees: template.assignees,
    });
  };

  const missing = missingRequiredTemplateFields(fields, values);
  const blocked =
    issueCreateBlocked({
      hasScope: scope !== null,
      canWrite,
      templates: scope?.templates
        ? {
            pending: templatesQuery.isPending,
            error: templatesQuery.error,
            list: templatesQuery.data,
          }
        : null,
      blankChosen: templateKey === BLANK,
      issueTypes:
        scope?.createIssueTypes === true
          ? {
              pending: candidatesQuery.isPending,
              error: candidatesQuery.error,
              count: issueTypes.length,
              chosen: chosenIssueType,
            }
          : null,
    }) ?? (missing.length > 0 ? `Fill in ${missing.join(", ")}.` : null);

  const submit = async () => {
    if (scope === null || pending || blocked !== null) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    setPending(true);
    const result = await create({
      environmentId: scope.environmentId,
      input: {
        ...scope.scope,
        title: trimmedTitle,
        body: fields.length > 0 ? composeTemplateBody(fields, values) : body,
        ...(selectedTemplate ? { templateKey: selectedTemplate.key } : {}),
        ...(parent ? { parentKey: parent.key } : {}),
        labels: extras.labels.map((label) => label.id ?? label.name),
        assignees: extras.assignees,
        ...(chosenIssueType === null ? {} : { issueType: chosenIssueType }),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The issue could not be created",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    const warnings = result.value.warnings ?? [];
    toastManager.add(
      warnings.length === 0
        ? { type: "success", title: `Created ${result.value.displayKey}` }
        : {
            type: "warning",
            title: `Created ${result.value.displayKey} with warnings`,
            description: warnings.join(" "),
          },
    );
    reset();
    onCreated(scope, result.value);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {parent ? `New sub-issue of ${parent.displayKey}` : "New issue"}
          </DialogTitle>
          <DialogDescription>File an issue on the project's tracker.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap gap-3">
            {scopes.length > 1 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-scope">Project</Label>
                <Select
                  value={String(scopeIndex)}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setScopeIndex(Number(value));
                    setTemplateKey(BLANK);
                    setExtras({ labels: [], assignees: [] });
                    setIssueType(null);
                  }}
                >
                  <SelectTrigger id="issue-create-scope" size="sm" aria-label="Project">
                    <SelectValue>
                      {scope ? `${scope.projectTitle} · ${scope.scope.scope}` : ""}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {scopes.map((entry, index) => (
                      <SelectItem
                        key={`${entry.environmentId}:${entry.scope.projectId}`}
                        value={String(index)}
                      >
                        {entry.projectTitle} · {entry.scope.scope}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {scope?.templates && (templates.length > 0 || templatesQuery.isPending) ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-template">Template</Label>
                <Select
                  value={templateKey}
                  onValueChange={chooseTemplate}
                  disabled={templatesQuery.isPending}
                >
                  <SelectTrigger id="issue-create-template" size="sm" aria-label="Template">
                    <SelectValue>
                      {templatesQuery.isPending
                        ? "Loading templates…"
                        : (templates.find((t) => t.key === templateKey)?.name ?? "Blank issue")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {blankAllowed ? <SelectItem value={BLANK}>Blank issue</SelectItem> : null}
                    {templates.map((template) => (
                      <SelectItem key={template.key} value={template.key}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{template.name}</span>
                          {template.about ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {template.about}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {scope?.createIssueTypes === true && issueTypes.length > 1 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="issue-create-type">Issue type</Label>
                <Select
                  value={chosenIssueType ?? ""}
                  onValueChange={(value) => setIssueType(value || null)}
                >
                  <SelectTrigger id="issue-create-type" size="sm" aria-label="Issue type">
                    <SelectValue>
                      {issueTypes.find((type) => type.id === chosenIssueType)?.name ??
                        "Choose a type"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {issueTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>
          {externalTemplates.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              Fill in on the tracker:
              {externalTemplates.map((template) => (
                <InlineButton
                  key={template.url}
                  title={template.about || undefined}
                  render={<a href={template.url} target="_blank" rel="noreferrer noopener" />}
                >
                  {template.name}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              ))}
            </p>
          ) : null}
          {(templatesQuery.data?.contactLinks?.length ?? 0) > 0 ? (
            <p className="flex flex-wrap gap-3 text-xs">
              {templatesQuery.data?.contactLinks?.map((link) => (
                <InlineButton
                  key={link.url}
                  title={link.about}
                  render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
                >
                  {link.name}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              ))}
            </p>
          ) : null}
          {templatesQuery.data?.contributingGuidelinesUrl ? (
            <InlineButton
              render={
                <a
                  href={templatesQuery.data.contributingGuidelinesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              Contributing guidelines
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="issue-create-title">Title</Label>
            <Input
              id="issue-create-title"
              autoFocus
              value={title}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="A short summary"
            />
          </div>
          {fields.length > 0 ? (
            <IssueTemplateForm fields={fields} values={values} onChange={setValues} />
          ) : (
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-create-body">Description</Label>
              <Textarea
                id="issue-create-body"
                size="lg"
                value={body}
                disabled={pending}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Markdown is supported"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
          )}
          {scope ? (
            <div className="flex flex-wrap items-center gap-2">
              {scope.labels ? (
                <IssueLabelPicker
                  environmentId={scope.environmentId}
                  source={scope.scope}
                  selected={extras.labels}
                  allowed={canWrite}
                  disabled={pending}
                  onChange={(next) => setExtras((held) => ({ ...held, labels: next }))}
                />
              ) : null}
              {scope.assignees ? (
                <IssueAssigneePicker
                  environmentId={scope.environmentId}
                  source={scope.scope}
                  selected={extras.assignees.map((id) => ({
                    id,
                    login: id,
                    name: null,
                    avatarUrl: null,
                  }))}
                  max={scope.maxAssignees ?? 100}
                  allowed={canWrite}
                  disabled={pending}
                  onChange={(next) =>
                    setExtras((held) => ({ ...held, assignees: next.map(issueAssigneeId) }))
                  }
                />
              ) : null}
            </div>
          ) : null}
          {extras.labels.length > 0 || extras.assignees.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {extras.labels.length > 0
                ? `Labels: ${extras.labels.map((label) => label.name).join(", ")}`
                : null}
              {extras.labels.length > 0 && extras.assignees.length > 0 ? " · " : null}
              {extras.assignees.length > 0 ? `Assignees: ${extras.assignees.join(", ")}` : null}
            </p>
          ) : null}
          {blocked ? <p className="text-xs text-muted-foreground">{blocked}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending || blocked !== null || title.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? "Creating…" : "Create issue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
