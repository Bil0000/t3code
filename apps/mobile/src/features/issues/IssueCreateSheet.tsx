import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { use, useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { MaterialButton } from "../../components/MaterialButton";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { PullRequestSheetContent as SheetContent } from "../pull-requests/PullRequestSheetContent";
import { issueCreateBlocked, resolveIssueType } from "./issueDetail";
import type { IssueCreateScope } from "./issueList";
import { useOpenIssue } from "./useOpenIssue";
import { markIssueWritten } from "./issueList";

const BLANK = "";

export function IssueCreateSheet({
  route,
}: StaticScreenProps<{ readonly scopes: ReadonlyArray<IssueCreateScope> }>) {
  const { scopes } = route.params;
  const registry = use(RegistryContext);
  const openIssue = useOpenIssue({ replace: true });
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)] ?? null;
  const [templateKey, setTemplateKey] = useState(BLANK);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extras, setExtras] = useState<{
    labels: ReadonlyArray<string>;
    assignees: ReadonlyArray<string>;
  }>({ labels: [], assignees: [] });
  const [issueType, setIssueType] = useState<string | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const canWrite = useAtomValue(
    issueEnvironment.create.permissionAtom(scope?.environmentId ?? null),
  );
  const templatesQuery = useEnvironmentQuery(
    scope?.templates
      ? issueEnvironment.templates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const templates = templatesQuery.data?.templates ?? [];
  const externalTemplates = templatesQuery.data?.externalTemplates ?? [];
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;
  const candidatesQuery = useEnvironmentQuery(
    scope?.createIssueTypes === true
      ? issueEnvironment.candidates({ environmentId: scope.environmentId, input: scope.scope })
      : null,
  );
  const issueTypes = candidatesQuery.data?.issueTypes ?? [];
  const chosenIssueType = resolveIssueType(issueTypes, issueType);
  const blocked = issueCreateBlocked({
    hasScope: scope !== null,
    canWrite,
    templates: scope?.templates
      ? { pending: templatesQuery.isPending, list: templatesQuery.data }
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
  });
  const select = (event: string) => {
    let selection: unknown;
    try {
      selection = JSON.parse(event);
    } catch {
      return;
    }
    if (!Array.isArray(selection) || typeof selection[0] !== "string") return;
    const [field, value] = selection as [string, string];
    if (field === "scope") {
      const index = Number(value);
      if (!Number.isInteger(index) || !scopes[index]) return;
      setScopeIndex(index);
      setTemplateKey(BLANK);
      setExtras({ labels: [], assignees: [] });
      setIssueType(null);
    } else if (field === "template") {
      const template = templates.find((entry) => entry.key === value);
      setTemplateKey(template ? template.key : BLANK);
      if (!template) {
        setExtras({ labels: [], assignees: [] });
        return;
      }
      if (title.trim().length === 0) setTitle(template.title);
      if (body.trim().length === 0) setBody(template.body);
      setExtras({ labels: template.labels, assignees: template.assignees });
    } else if (field === "type" && issueTypes.some((type) => type.id === value)) {
      setIssueType(value);
    }
  };
  const submit = async () => {
    if (pending.current || scope === null || blocked !== null || !title.trim()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await create({
        environmentId: scope.environmentId,
        input: {
          ...scope.scope,
          title: title.trim(),
          body,
          labels: extras.labels,
          assignees: extras.assignees,
          ...(chosenIssueType === null ? {} : { issueType: chosenIssueType }),
        },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      markIssueWritten(registry, scope.environmentId, scope.scope);
      openIssue({
        environmentId: scope.environmentId,
        projectId: scope.scope.projectId,
        tracker: scope.scope.tracker,
        host: scope.scope.host,
        scope: scope.scope.scope,
        key: response.value.key,
        displayKey: response.value.displayKey,
      });
      if (response.value.warnings?.length)
        Alert.alert(`Created ${response.value.displayKey}`, response.value.warnings.join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The tracker refused it. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const choice = (field: string, value: string, title: string, on: boolean) => ({
    id: JSON.stringify([field, value]),
    title,
    state: on ? ("on" as const) : ("off" as const),
  });
  return (
    <SheetContent
      title="New issue"
      subtitle={
        scope ? `${scope.projectTitle} · ${scope.scope.scope}` : "No project can file issues"
      }
      busy={busy}
      footer={
        <MaterialButton
          label={busy ? "Creating…" : "Create issue"}
          fullWidth
          tone={Platform.OS === "android" ? "primary" : "contrast"}
          loading={busy}
          disabled={blocked !== null || !title.trim()}
          onPress={() => void submit()}
        />
      }
    >
      <View className="flex-row flex-wrap gap-2">
        {scopes.length > 1 ? (
          <ListFilterMenu
            label={scope ? `${scope.projectTitle} · ${scope.scope.scope}` : "Project"}
            accessibilityLabel="Project"
            actions={scopes.map((entry, index) =>
              choice(
                "scope",
                String(index),
                `${entry.projectTitle} · ${entry.scope.scope}`,
                index === scopeIndex,
              ),
            )}
            onSelect={select}
          />
        ) : null}
        {scope?.templates && (templates.length > 0 || templatesQuery.isPending) ? (
          <ListFilterMenu
            label={
              templatesQuery.isPending
                ? "Loading templates…"
                : (templates.find((entry) => entry.key === templateKey)?.name ?? "Blank issue")
            }
            accessibilityLabel="Template"
            actions={[
              ...(blankAllowed
                ? [choice("template", BLANK, "Blank issue", templateKey === BLANK)]
                : []),
              ...templates.map((template) => ({
                ...choice("template", template.key, template.name, template.key === templateKey),
                ...(template.about ? { subtitle: template.about } : {}),
              })),
            ]}
            onSelect={select}
          />
        ) : null}
        {scope?.createIssueTypes === true && issueTypes.length > 1 ? (
          <ListFilterMenu
            label={issueTypes.find((type) => type.id === chosenIssueType)?.name ?? "Choose a type"}
            active={chosenIssueType === null}
            accessibilityLabel="Issue type"
            actions={issueTypes.map((type) =>
              choice("type", type.id, type.name, type.id === chosenIssueType),
            )}
            onSelect={select}
          />
        ) : null}
      </View>
      {externalTemplates.map((template) => (
        <Pressable
          key={template.url}
          accessibilityRole="link"
          accessibilityLabel={`Fill in ${template.name} on the tracker`}
          onPress={() => void Linking.openURL(template.url)}
          className="flex-row items-center gap-1.5 active:opacity-70"
        >
          <Text className="text-xs text-primary-text">{template.name}</Text>
          <SymbolView name="arrow.up.right" size={10} tintColorClassName="accent-link" />
        </Pressable>
      ))}
      <TextInput
        accessibilityLabel="Title"
        placeholder="A short summary"
        placeholderTextColorClassName="accent-foreground-muted"
        editable={!busy}
        value={title}
        maxLength={1024}
        onChangeText={setTitle}
        className="min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
      />
      <TextInput
        multiline
        accessibilityLabel="Description"
        placeholder="Markdown is supported"
        placeholderTextColorClassName="accent-foreground-muted"
        editable={!busy}
        value={body}
        maxLength={65536}
        onChangeText={setBody}
        className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {extras.labels.length || extras.assignees.length ? (
        <Text className="text-xs text-foreground-muted">
          {[
            extras.labels.length ? `Labels: ${extras.labels.join(", ")}` : null,
            extras.assignees.length ? `Assignees: ${extras.assignees.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
      {blocked ? <Text className="text-xs text-foreground-muted">{blocked}</Text> : null}
      {scope?.templates && templatesQuery.error ? (
        <View className="gap-2">
          <Text selectable className="text-sm text-danger-foreground">
            {templatesQuery.error}
          </Text>
          <MaterialButton label="Retry templates" tone="text" onPress={templatesQuery.refresh} />
        </View>
      ) : null}
      {scope?.createIssueTypes === true && candidatesQuery.error ? (
        <MaterialButton label="Retry issue types" tone="text" onPress={candidatesQuery.refresh} />
      ) : null}
      {error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </SheetContent>
  );
}
