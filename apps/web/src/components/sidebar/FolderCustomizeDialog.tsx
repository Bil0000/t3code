import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import type { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { threadMatchesFolderRule } from "@t3tools/shared/threadFolderRule";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { FolderOpenIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  initialProjectIconDraft,
  projectIconColorClassName,
  projectIconFromDraft,
} from "../../projectIconOptions";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { lucideIconByName } from "../../lib/lucideIconByName";
import { mutateThreadFolders, suggestThreadFolderRule } from "../../state/threadFolders";
import { ProjectIconOverrideGlyph } from "../ProjectFavicon";
import { ProjectIconPicker } from "../settings/ProjectIconPickerDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  addRulePattern,
  buildFolderUpdate,
  folderRuleDraft,
  folderRuleFromDraft,
  MAX_RULE_ENTRIES,
  type FolderRuleDraft,
} from "./folderCustomize.logic";
import { threadFolderTintClassName } from "./SidebarThreadFolderHeader";

type FolderCustomizeTab = "appearance" | "auto-file";

const MAX_NAME_LENGTH = 80;

function lastSegment(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? path
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RulePatternField({
  id,
  label,
  placeholder,
  hint,
  values,
  display,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  hint?: string;
  values: ReadonlyArray<string>;
  display?: (value: string) => string;
  onChange: (values: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = useState("");
  const commit = () => {
    onChange(addRulePattern(values, text));
    setText("");
  };
  return (
    <Field label={label} htmlFor={id} {...(hint ? { hint } : {})}>
      <Input
        id={id}
        size="sm"
        value={text}
        placeholder={values.length >= MAX_RULE_ENTRIES ? "Limit reached" : placeholder}
        disabled={values.length >= MAX_RULE_ENTRIES}
        autoComplete="off"
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && text === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
      />
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <Badge key={value} variant="outline" size="control" title={value}>
              <span className="max-w-48 truncate">{display ? display(value) : value}</span>
              <Button
                size="icon-tiny"
                variant="ghost-muted"
                aria-label={`Remove ${display ? display(value) : value}`}
                onClick={() => onChange(values.filter((entry) => entry !== value))}
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
        </div>
      ) : null}
    </Field>
  );
}

function FolderCardPreview({
  folder,
  name,
  icon,
  memberTitles,
}: {
  folder: EnvironmentThreadFolder;
  name: string;
  icon: ReturnType<typeof projectIconFromDraft>;
  memberTitles: ReadonlyArray<string>;
}) {
  const color = icon && icon.kind !== "emoji" ? icon.color : null;
  const nameClassName = color ? projectIconColorClassName(color) : "text-foreground";
  return (
    <div
      aria-hidden
      className={cn("rounded-lg border border-border/60 p-1", threadFolderTintClassName(icon))}
    >
      <div className="flex h-9 items-center gap-2 px-2">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-[25%]",
            icon?.kind !== "monogram" && "bg-current/14",
            nameClassName,
          )}
        >
          {icon ? (
            <ProjectIconOverrideGlyph
              icon={icon}
              className={icon.kind === "monogram" ? "size-5" : "size-3.5"}
            />
          ) : (
            <FolderOpenIcon className="size-3.5" />
          )}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-sm font-semibold", nameClassName)}>
          {name.trim() || folder.name}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {folder.threadIds.length}
        </span>
      </div>
      {(memberTitles.length > 0 ? memberTitles : ["Threads you file here"]).map((title) => (
        <div key={title} className="truncate px-2 pb-1.5 ps-9 text-xs text-muted-foreground">
          {title}
        </div>
      ))}
    </div>
  );
}

function matchesShell(rule: NonNullable<ReturnType<typeof folderRuleFromDraft>>) {
  return (thread: EnvironmentThreadShell) =>
    threadMatchesFolderRule(rule, {
      ...thread,
      hasPullRequest: visibleThreadPullRequests(thread.pullRequests).length > 0,
    });
}

export default function FolderCustomizeDialog(props: {
  folder: EnvironmentThreadFolder;
  initialTab?: FolderCustomizeTab;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full sm:w-[34rem]">
        {/* The popup mounts per open, so the draft below starts from the folder each time. */}
        <FolderCustomizeBody
          folder={props.folder}
          initialTab={props.initialTab ?? "appearance"}
          onClose={() => props.onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function FolderCustomizeBody({
  folder,
  initialTab,
  onClose,
}: {
  folder: EnvironmentThreadFolder;
  initialTab: FolderCustomizeTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState(folder.name);
  const [hasIcon, setHasIcon] = useState(folder.icon !== null);
  const [iconDraft, setIconDraft] = useState(() =>
    initialProjectIconDraft(folder.icon, folder.name),
  );
  const [rule, setRule] = useState(() => folderRuleDraft(folder.rule));
  const [autoFile, setAutoFile] = useState(folder.rule === null ? true : folder.autoFile);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const allThreads = useQuietThreadShells();
  const allProjects = useProjects();
  const providers = useEnvironmentProviders().get(folder.environmentId) ?? [];
  const threads = allThreads.filter(
    (thread) =>
      thread.environmentId === folder.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent",
  );
  const projects = allProjects.filter(
    (project) => project.environmentId === folder.environmentId && !project.isScratch,
  );
  const memberIds = new Set<string>(folder.threadIds);
  const members = threads.filter((thread) => memberIds.has(thread.id));
  const firstMember = members[0] ?? null;

  const icon = hasIcon ? projectIconFromDraft(iconDraft) : null;
  const iconInvalid = hasIcon && icon === null;
  const savedRule = folderRuleFromDraft(rule);
  const matchCount = savedRule ? threads.filter(matchesShell(savedRule)).length : 0;
  const update = buildFolderUpdate(folder, { name, icon, rule, autoFile });
  const nameInvalid = name.trim() === "";
  const updateRule = (patch: Partial<FolderRuleDraft>) => setRule({ ...rule, ...patch });

  const projectTitle = (id: ProjectId) =>
    projects.find((project) => project.id === id)?.title ?? id;
  const providerTitle = (id: ProviderInstanceId) => {
    const provider = providers.find((entry) => entry.instanceId === id);
    return provider ? resolveProviderInstanceDisplayName(provider) : id;
  };

  const save = async () => {
    if (update === null) {
      onClose();
      return;
    }
    setSaving(true);
    const result = await mutateThreadFolders(folder.environmentId, update, "Could not save folder");
    setSaving(false);
    if (result !== null) onClose();
  };

  const suggest = async () => {
    setSuggesting(true);
    const suggestion = await suggestThreadFolderRule(folder.environmentId, name.trim());
    setSuggesting(false);
    if (suggestion === null) return;
    setRule(folderRuleDraft(suggestion.rule));
    setAutoFile(true);
    // Keep a chosen icon; the model's pick fills only an empty one, and only a real Lucide name.
    if (!hasIcon && suggestion.icon?.kind === "lucide" && lucideIconByName(suggestion.icon.name)) {
      setHasIcon(true);
      setIconDraft({
        ...iconDraft,
        mode: "lucide",
        iconName: suggestion.icon.name,
        color: suggestion.icon.color,
      });
    }
  };

  const presets = [
    ...(firstMember?.branch
      ? [
          {
            label: "This branch",
            apply: () =>
              updateRule({ branches: addRulePattern(rule.branches, firstMember.branch ?? "") }),
          },
        ]
      : []),
    ...(firstMember?.worktreePath
      ? [
          {
            label: "This worktree",
            apply: () =>
              updateRule({
                worktrees: addRulePattern(rule.worktrees, firstMember.worktreePath ?? ""),
              }),
          },
        ]
      : []),
    { label: "Pull requests", apply: () => updateRule({ pullRequest: true }) },
    {
      label: "Reviews",
      apply: () => updateRule({ titleKeywords: addRulePattern(rule.titleKeywords, "review") }),
    },
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Customize folder</DialogTitle>
        <DialogDescription>
          Change how the folder looks and which threads it collects.
        </DialogDescription>
        <ToggleGroup
          aria-label="Section"
          variant="segmented"
          className="mt-2 w-full *:flex-1"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "appearance" || value === "auto-file") setTab(value);
          }}
        >
          <Toggle value="appearance">Appearance</Toggle>
          <Toggle value="auto-file">Auto-file</Toggle>
        </ToggleGroup>
      </DialogHeader>
      <DialogPanel>
        {tab === "appearance" ? (
          <>
            <Field label="Name" htmlFor="folder-customize-name">
              <Input
                id="folder-customize-name"
                value={name}
                maxLength={MAX_NAME_LENGTH}
                aria-invalid={nameInvalid}
                autoComplete="off"
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Field>
            <ProjectIconPicker
              draft={iconDraft}
              onDraftChange={(draft) => {
                setIconDraft(draft);
                setHasIcon(true);
              }}
              preview={
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label render={<div />}>Preview</Label>
                    {hasIcon ? (
                      <Button
                        size="xs"
                        variant="ghost-destructive"
                        onClick={() => setHasIcon(false)}
                      >
                        Remove icon
                      </Button>
                    ) : null}
                  </div>
                  <FolderCardPreview
                    folder={folder}
                    name={name}
                    icon={icon}
                    memberTitles={members.slice(0, 2).map((thread) => thread.title)}
                  />
                </div>
              }
            />
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 rounded-xl border bg-muted/40 p-3">
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor="folder-customize-auto-file">Auto-file new threads</Label>
                <p className="text-xs text-muted-foreground">
                  {savedRule
                    ? `Matches ${plural(matchCount, "current thread")}. New matching threads are filed here; use File matching threads now in the folder menu for existing ones.`
                    : "Add a condition below to file matching new threads here."}
                </p>
              </div>
              <Switch
                id="folder-customize-auto-file"
                checked={savedRule !== null && autoFile}
                disabled={savedRule === null}
                onCheckedChange={setAutoFile}
              />
            </div>

            <div className="space-y-1.5">
              <Label render={<div />}>Quick start</Label>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={suggesting || nameInvalid}
                  onClick={() => void suggest()}
                >
                  <SparklesIcon aria-hidden />
                  {suggesting ? "Suggesting…" : "Suggest rule"}
                </Button>
                {presets.map((preset) => (
                  <Button key={preset.label} size="xs" variant="outline" onClick={preset.apply}>
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <RulePatternField
              id="folder-rule-branches"
              label="Branch"
              placeholder="feature/*, then Enter"
              hint="Use * to match any run of characters."
              values={rule.branches}
              onChange={(branches) => updateRule({ branches })}
            />
            <RulePatternField
              id="folder-rule-worktrees"
              label="Worktree"
              placeholder="Folder name or full path"
              values={rule.worktrees}
              display={lastSegment}
              onChange={(worktrees) => updateRule({ worktrees })}
            />
            <RulePatternField
              id="folder-rule-keywords"
              label="Title words"
              placeholder="review, fix, …"
              values={rule.titleKeywords}
              onChange={(titleKeywords) => updateRule({ titleKeywords })}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project">
                <Select
                  multiple
                  value={[...rule.projectIds]}
                  onValueChange={(projectIds) =>
                    updateRule({ projectIds: projectIds.slice(0, MAX_RULE_ENTRIES) })
                  }
                >
                  <SelectTrigger size="sm" aria-label="Projects">
                    <SelectValue>
                      {rule.projectIds.length === 0
                        ? "Any project"
                        : rule.projectIds.map(projectTitle).join(", ")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Provider">
                <Select
                  multiple
                  value={[...rule.providerInstanceIds]}
                  onValueChange={(providerInstanceIds) =>
                    updateRule({
                      providerInstanceIds: providerInstanceIds.slice(0, MAX_RULE_ENTRIES),
                    })
                  }
                >
                  <SelectTrigger size="sm" aria-label="Providers">
                    <SelectValue>
                      {rule.providerInstanceIds.length === 0
                        ? "Any provider"
                        : rule.providerInstanceIds.map(providerTitle).join(", ")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {providers.map((provider) => (
                      <SelectItem key={provider.instanceId} value={provider.instanceId}>
                        {resolveProviderInstanceDisplayName(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            <Field label="Pull request">
              <ToggleGroup
                aria-label="Pull request"
                variant="segmented"
                value={[rule.pullRequest === null ? "any" : rule.pullRequest ? "yes" : "no"]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === undefined) return;
                  updateRule({ pullRequest: value === "any" ? null : value === "yes" });
                }}
              >
                <Toggle value="any">Any</Toggle>
                <Toggle value="yes">Has one</Toggle>
                <Toggle value="no">Has none</Toggle>
              </ToggleGroup>
            </Field>

            {savedRule ? (
              <Button
                size="xs"
                variant="ghost-destructive"
                onClick={() => setRule(folderRuleDraft(null))}
              >
                Clear rule
              </Button>
            ) : null}
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || nameInvalid || iconInvalid}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
