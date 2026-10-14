import { RegistryContext } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { use, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { EmptyState } from "../../components/EmptyState";
import { MaterialButton } from "../../components/MaterialButton";
import { SymbolView } from "../../components/AppSymbol";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import { issueAssigneeId } from "./issueDetail";
import {
  heldIssuePicker,
  issueLabelId,
  issuePickerIds,
  nextIssuePickerIds,
  type IssuePickerConfirmed,
} from "./issuePicker";
import type { IssueAssigneeCandidate } from "@t3tools/contracts";
import type { IssueParams } from "./issueSelection";
import { issueTarget, markIssueTargetWritten, useIssueAccess } from "./useIssueAccess";

type Row = {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly selected: boolean;
  readonly color: string | null;
  readonly actor: IssueAssigneeCandidate | null;
};

export function IssueCandidatesScreen({
  route,
}: StaticScreenProps<IssueParams & { readonly kind: "labels" | "assignees" }>) {
  const params = route.params;
  const labels = params.kind === "labels";
  const navigation = useNavigation();
  const registry = use(RegistryContext);
  const target = issueTarget(params);
  const detail = useEnvironmentQuery(issueEnvironment.detail(target));
  const issue = detail.data;
  const access = useIssueAccess(params, issue);
  const allowed = labels ? access.labels : access.assignees;
  const scope = {
    environmentId: target.environmentId,
    input: {
      projectId: target.input.projectId,
      tracker: target.input.tracker,
      host: params.host,
      scope: params.scope,
    },
  };
  const result = useEnvironmentQuery(issueEnvironment.candidates(scope));
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<IssuePickerConfirmed | null>(null);
  const held = issue ? heldIssuePicker(issue, params.kind, confirmed, target.environmentId) : null;
  if (confirmed !== held) setConfirmed(held);
  const inFlight = useRef(false);
  const title = labels ? "Labels" : "Assignees";
  const rows = useMemo((): Row[] => {
    if (!issue) return [];
    const needle = query.trim().toLowerCase();
    const matches = (...fields: ReadonlyArray<string | null | undefined>) =>
      fields.some((field) => (field ?? "").toLowerCase().includes(needle));
    if (labels) {
      const fetched = result.data?.labels ?? [];
      const applied = new Set(issuePickerIds(issue, "labels", held, target.environmentId));
      return [
        ...fetched,
        ...issue.labels
          .filter(
            (label) =>
              !fetched.some((candidate) => issueLabelId(candidate) === issueLabelId(label)),
          )
          .map((label) => ({ ...label, description: null })),
      ]
        .filter((label) => matches(label.name, label.description))
        .map((label) => ({
          id: issueLabelId(label),
          title: label.name,
          detail: label.description,
          selected: applied.has(issueLabelId(label)),
          color: pullRequestLabelColor(label.color),
          actor: null,
        }));
    }
    const fetched = result.data?.assignees ?? [];
    const ids = issuePickerIds(issue, "assignees", held, target.environmentId);
    const current = issue.assignees.map((actor) => ({ ...actor, id: issueAssigneeId(actor) }));
    const assigned = (id: string) => ids.some((each) => each.toLowerCase() === id.toLowerCase());
    return [
      ...fetched,
      ...current.filter(
        (actor) =>
          !fetched.some((candidate) => candidate.id.toLowerCase() === actor.id.toLowerCase()),
      ),
    ]
      .filter((candidate) => matches(candidate.login, candidate.name, candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.name || candidate.login,
        detail: candidate.name ? candidate.login : null,
        selected: assigned(candidate.id),
        color: null,
        actor: candidate,
      }));
  }, [issue, labels, query, result.data, held, target.environmentId]);
  const toggle = async (row: Row) => {
    if (!allowed || !issue || inFlight.current) return;
    inFlight.current = true;
    setPending(row.id);
    setError(null);
    try {
      const ids = nextIssuePickerIds(issue, params.kind, held, row.id, target.environmentId);
      const response = await update({
        ...target,
        input: { ...target.input, [params.kind]: ids },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      setConfirmed({ base: issue, ids, environmentId: target.environmentId, kind: params.kind });
      markIssueTargetWritten(registry, params);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Couldn't update ${title.toLowerCase()}.`);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  return (
    <View className="flex-1 bg-sheet">
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          icon="xmark"
          accessibilityLabel={`Close ${title.toLowerCase()}`}
          onPress={() => navigation.goBack()}
        />
      </NativeHeaderToolbar>
      <NativeStackScreenOptions
        options={{
          title,
          unstable_headerSubtitle: `${issue?.displayKey ?? params.displayKey ?? params.key} · ${params.scope}`,
          headerSearchBarOptions: {
            placeholder: `Search ${title.toLowerCase()}`,
            autoCapitalize: "none",
            onChangeText: (event) => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(""),
            hideNavigationBar: false,
            hideWhenScrolling: false,
            obscureBackground: false,
            placement: "stacked",
          },
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-3 px-4 py-4">
            {Platform.OS === "android" ? (
              <TextInput
                accessibilityLabel={`Search ${title.toLowerCase()}`}
                placeholder={`Search ${title.toLowerCase()}`}
                placeholderTextColorClassName="accent-foreground-muted"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                className="min-h-11 rounded-xl bg-grouped-card px-3 text-sm"
              />
            ) : null}
            {issue && !allowed ? (
              <Text className="text-xs text-foreground-muted">
                Changing {title.toLowerCase()} isn't available for this issue with your access.
              </Text>
            ) : !labels && issue?.capabilities.maxAssignees === 1 ? (
              <Text className="text-xs text-foreground-muted">
                This tracker takes one assignee; choosing someone replaces the current one.
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            {result.error ? (
              <View className="gap-2">
                <Text selectable className="text-sm text-danger-foreground">
                  {result.error}
                </Text>
                <MaterialButton label="Retry" onPress={result.refresh} />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.selected ? "Remove" : "Add"} ${item.title}`}
            accessibilityState={{ selected: item.selected, disabled: !allowed || pending !== null }}
            disabled={!allowed || pending !== null}
            onPress={() => void toggle(item)}
            className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
          >
            {labels ? (
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: item.color ?? undefined,
                }}
                className={item.color ? undefined : "bg-subtle-strong"}
              />
            ) : (
              <PullRequestAvatar actor={item.actor} size={28} />
            )}
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm font-t3-medium" numberOfLines={1}>
                {item.title}
              </Text>
              {item.detail ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {item.detail}
                </Text>
              ) : null}
            </View>
            {pending === item.id ? (
              <ActivityIndicator />
            ) : item.selected ? (
              <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" />
            ) : (
              <SymbolView name="plus" size={16} tintColorClassName="accent-icon-muted" />
            )}
          </Pressable>
        )}
        ListEmptyComponent={
          (result.isPending && !result.data) || (detail.isPending && !issue) ? (
            <ActivityIndicator className="my-8" />
          ) : (
            <View className="px-4 py-6">
              <EmptyState
                title={
                  result.error || detail.error
                    ? `Couldn't load ${title.toLowerCase()}`
                    : query.trim()
                      ? "No matches"
                      : `No ${title.toLowerCase()} available`
                }
                detail={detail.error ?? "The tracker offered none for this scope."}
                variant="plain"
              />
            </View>
          )
        }
        ListFooterComponent={
          result.data?.truncated ? (
            <Text className="px-4 py-4 text-xs text-foreground-muted">
              The tracker has more than it returned. More choices are on the tracker.
            </Text>
          ) : undefined
        }
      />
    </View>
  );
}
