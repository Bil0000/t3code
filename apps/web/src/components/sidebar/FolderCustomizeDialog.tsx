import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import type { ThreadFolderRule } from "@t3tools/contracts";
import { threadMatchesFolderRule } from "@t3tools/shared/threadFolderRule";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { FolderOpenIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  initialProjectIconDraft,
  projectIconColorClassName,
  projectIconFromDraft,
} from "../../projectIconOptions";
import { useQuietThreadShells } from "../../state/entities";
import { mutateThreadFolders } from "../../state/threadFolders";
import { ProjectIconOverrideGlyph } from "../ProjectFavicon";
import { ProjectIconPicker } from "../settings/ProjectIconPickerDialog";
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
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  buildFolderUpdate,
  folderRuleEditor,
  folderRuleFromEditor,
  type FolderRuleMode,
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

function ruleSummary(rule: ThreadFolderRule) {
  return [
    rule.smart ? "Work fits the folder name" : null,
    rule.branches ? `Branch ${rule.branches.join(", ")}` : null,
    rule.worktrees ? `Worktree ${rule.worktrees.map(lastSegment).join(", ")}` : null,
    rule.titleKeywords ? `Title has ${rule.titleKeywords.join(", ")}` : null,
    rule.projectIds ? plural(rule.projectIds.length, "project") : null,
    rule.providerInstanceIds ? plural(rule.providerInstanceIds.length, "provider") : null,
    rule.pullRequest === undefined
      ? null
      : rule.pullRequest
        ? "Has a pull request"
        : "No pull request",
  ]
    .filter((part) => part !== null)
    .join(" · ");
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

function FolderCardPreview({
  folder,
  name,
  icon,
}: {
  folder: EnvironmentThreadFolder;
  name: string;
  icon: ReturnType<typeof projectIconFromDraft>;
}) {
  const color = icon && icon.kind !== "emoji" ? icon.color : null;
  const nameClassName = color ? projectIconColorClassName(color) : "text-foreground";
  return (
    <div
      aria-hidden
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg border border-border/60 px-2",
        threadFolderTintClassName(icon),
      )}
    >
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
  );
}

function matchesShell(rule: ThreadFolderRule) {
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
  const allThreads = useQuietThreadShells();
  const threads = allThreads.filter(
    (thread) =>
      thread.environmentId === folder.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent",
  );
  const memberIds = new Set<string>(folder.threadIds);
  const firstMember = threads.find((thread) => memberIds.has(thread.id)) ?? null;
  const editor = folderRuleEditor(folder.rule);

  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState(folder.name);
  const [hasIcon, setHasIcon] = useState(folder.icon !== null);
  const [iconDraft, setIconDraft] = useState(() =>
    initialProjectIconDraft(folder.icon, folder.name),
  );
  const [enabled, setEnabled] = useState(folder.rule !== null && folder.autoFile);
  const [ruleCleared, setRuleCleared] = useState(false);
  const [mode, setMode] = useState<FolderRuleMode>(editor?.mode ?? "name");
  const [branch, setBranch] = useState(
    editor?.mode === "branch" ? editor.pattern : (firstMember?.branch ?? ""),
  );
  const [worktree, setWorktree] = useState(
    editor?.mode === "worktree"
      ? editor.pattern
      : firstMember?.worktreePath
        ? lastSegment(firstMember.worktreePath)
        : "",
  );
  const [saving, setSaving] = useState(false);

  const icon = hasIcon ? projectIconFromDraft(iconDraft) : null;
  const iconInvalid = hasIcon && icon === null;
  const advanced = editor === null && !ruleCleared;
  const simpleRule = folderRuleFromEditor(mode, mode === "branch" ? branch : worktree);
  const rule = enabled && !advanced ? simpleRule : ruleCleared ? null : folder.rule;
  const update = buildFolderUpdate(folder, { name, icon, rule, autoFile: enabled });
  const nameInvalid = name.trim() === "";
  const patternMissing = enabled && !advanced && simpleRule === null;

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
                  <FolderCardPreview folder={folder} name={name} icon={icon} />
                </div>
              }
            />
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="folder-customize-auto-file">Auto-file new threads</Label>
              <Switch
                id="folder-customize-auto-file"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>
            {advanced && folder.rule ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {ruleSummary(folder.rule)}
                </p>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() => {
                    setRuleCleared(true);
                    setEnabled(false);
                  }}
                >
                  Clear
                </Button>
              </div>
            ) : enabled ? (
              <>
                <Field label="Match by">
                  <ToggleGroup
                    aria-label="Match by"
                    variant="segmented"
                    className="w-full *:flex-1"
                    value={[mode]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "name" || value === "branch" || value === "worktree") {
                        setMode(value);
                      }
                    }}
                  >
                    <Toggle value="name">Name</Toggle>
                    <Toggle value="branch">Branch</Toggle>
                    <Toggle value="worktree">Worktree</Toggle>
                  </ToggleGroup>
                </Field>
                {mode === "name" ? (
                  <p className="text-xs text-muted-foreground">
                    Files threads whose work fits “{name.trim() || folder.name}”.
                  </p>
                ) : (
                  <Field
                    label={mode === "branch" ? "Branch" : "Worktree"}
                    htmlFor="folder-rule-pattern"
                    hint={`Use * to match any run of characters.${
                      simpleRule
                        ? ` Matches ${plural(threads.filter(matchesShell(simpleRule)).length, "current thread")}.`
                        : ""
                    }`}
                  >
                    <Input
                      id="folder-rule-pattern"
                      size="sm"
                      value={mode === "branch" ? branch : worktree}
                      maxLength={200}
                      aria-invalid={patternMissing}
                      placeholder={mode === "branch" ? "feature/*" : "Folder name or full path"}
                      autoComplete="off"
                      onChange={(event) =>
                        (mode === "branch" ? setBranch : setWorktree)(event.currentTarget.value)
                      }
                    />
                  </Field>
                )}
              </>
            ) : null}
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={() => void save()}
          disabled={saving || nameInvalid || iconInvalid || patternMissing}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
