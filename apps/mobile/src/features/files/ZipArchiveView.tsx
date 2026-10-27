import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  loadZipArchive,
  readZipArchiveStream,
  ZipPreviewError,
  type ZipPreviewEntry,
} from "@t3tools/client-runtime/zip-preview";
import type { EnvironmentId } from "@t3tools/contracts";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { decodeFilePreviewText, filePreviewKind } from "@t3tools/shared/filePreview";
import { LegendList } from "@legendapp/list/react-native";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Progress } from "../../components/ui/Progress";
import { Toolbar } from "../../components/ui/Toolbar";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import {
  nativeViewerErrorMessage,
  shareGeneratedAttachment,
  writeGeneratedAttachmentFile,
} from "../../lib/attachmentDownload";
import { attachmentDocumentPresentation } from "../../lib/attachmentDocumentPresentation";
import { createComposerFileAttachment } from "../../lib/composerImages";
import { appendComposerDraftAttachments } from "../../state/use-composer-drafts";
import { AttachmentDocumentBody } from "./AttachmentFileScreen";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import {
  buildZipTree,
  flattenZipTree,
  zipDownloadTimeLeft,
  zipFolderLabel,
  type ZipTreeRow,
} from "./zipTree";

type ZipArchive = Awaited<ReturnType<typeof loadZipArchive>>;
type ZipFailure = ZipPreviewError["reason"] | "network" | "cancelled";

function archiveFailure(reason: ZipFailure) {
  if (reason === "archive-limit" || reason === "entry-limit")
    return {
      title: "Too large to browse here",
      detail: "Browsing works up to 32 MB and 2,000 files. Save the ZIP to open it in another app.",
      retry: false,
    };
  if (reason === "encrypted")
    return {
      title: "This ZIP is password-protected",
      detail: "T3 Code can't open encrypted ZIPs. Save it and open it with its password.",
      retry: false,
    };
  if (reason === "unsupported")
    return {
      title: "This ZIP format isn't supported",
      detail: "Save the ZIP to open it in another app.",
      retry: false,
    };
  if (reason === "cancelled")
    return {
      title: "Download cancelled",
      detail: "The ZIP wasn't downloaded. Try again to list its files.",
      retry: true,
    };
  if (reason === "network")
    return {
      title: "Couldn't download this ZIP",
      detail: "Check the connection to this environment and try again.",
      retry: true,
    };
  return {
    title: "Couldn't read this ZIP",
    detail: "It may be incomplete or not a real ZIP. Try again, or ask for the file again.",
    retry: true,
  };
}

function failureReason(cause: unknown): ZipFailure {
  return cause instanceof ZipPreviewError ? cause.reason : "network";
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

type ArchiveState =
  | { readonly status: "loading"; readonly receivedBytes: number; readonly timeLeft: string | null }
  | { readonly status: "ready"; readonly archive: ZipArchive }
  | { readonly status: "failed"; readonly reason: ZipFailure };

function useZipArchive(input: {
  readonly uri: string | null;
  readonly isLocal: boolean;
  readonly sizeBytes: number;
  readonly refresh: () => Promise<string | null>;
}) {
  const [state, setState] = useState<ArchiveState>({
    status: "loading",
    receivedBytes: 0,
    timeLeft: null,
  });
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const { uri, isLocal, sizeBytes, refresh } = input;
  // oxlint-disable-next-line t3code/react-effect-budget -- Load archive bytes and cancel the stream on cleanup.
  useEffect(() => {
    if (!uri) return;
    const abort = new AbortController();
    controller.current = abort;
    const startedAt = Date.now();
    // oxlint-disable-next-line react/set-state-in-effect -- A new archive load resets its progress.
    setState({ status: "loading", receivedBytes: 0, timeLeft: null });
    void (async () => {
      const body = isLocal
        ? new File(uri).readableStream()
        : await (async () => {
            const url = (await refresh()) ?? uri;
            const response = await fetch(url, { signal: abort.signal });
            if (!response.ok || !response.body) throw new Error("Could not load this ZIP file.");
            return response.body;
          })();
      const bytes = await readZipArchiveStream(body, abort.signal, (receivedBytes) =>
        setState({
          status: "loading",
          receivedBytes,
          timeLeft: zipDownloadTimeLeft({
            receivedBytes,
            totalBytes: sizeBytes,
            elapsedMs: Date.now() - startedAt,
          }),
        }),
      );
      return loadZipArchive(bytes, abort.signal);
    })()
      .then((archive) => {
        if (!abort.signal.aborted) setState({ status: "ready", archive });
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setState({ status: "failed", reason: failureReason(cause) });
      });
    return () => abort.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reload the archive.
  }, [uri, isLocal, sizeBytes, refresh, revision]);
  return {
    state,
    retry: () => setRevision((value) => value + 1),
    cancel: () => {
      controller.current?.abort();
      setState({ status: "failed", reason: "cancelled" });
    },
  };
}

function ZipTreeRowView(props: {
  readonly row: ZipTreeRow;
  readonly collapsed: boolean;
  readonly onToggle: (path: string) => void;
  readonly onOpen: (entry: ZipPreviewEntry) => void;
}) {
  const { node, depth } = props.row;
  const entry = node.entry;
  const folder = entry ? null : zipFolderLabel(node.label);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry ? entry.path : `${node.path} folder`}
      accessibilityState={entry ? undefined : { expanded: !props.collapsed }}
      onPress={() => (entry ? props.onOpen(entry) : props.onToggle(node.path))}
      className="mx-2 h-11 flex-row items-center gap-1.5 rounded-lg pr-2.5 active:bg-subtle"
      style={{ paddingLeft: 8 + depth * 18 }}
    >
      <View className="w-4 items-center">
        {entry ? null : (
          <SymbolView
            name={props.collapsed ? "chevron.right" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        )}
      </View>
      <View className="w-5 items-center">
        <PierreEntryIcon path={node.path} kind={entry ? "file" : "directory"} size={17} />
      </View>
      <Text className="min-w-0 flex-1 text-[15px] text-foreground" numberOfLines={1}>
        {folder ? (
          <>
            <Text className="text-[15px] text-foreground-muted">{folder.prefix}</Text>
            {folder.name}
          </>
        ) : (
          node.label
        )}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {entry
          ? formatAttachmentSize(entry.sizeBytes)
          : props.collapsed
            ? `${node.fileCount} ${node.fileCount === 1 ? "file" : "files"}`
            : ""}
      </Text>
    </Pressable>
  );
}

function ZipArchiveHeader(props: {
  readonly name: string;
  readonly subtitle: string;
  readonly tintColor: string;
  readonly onSave: () => void;
  readonly onRemove: (() => void) | null;
}) {
  const navigation = useNavigation();
  const isAndroid = Platform.OS === "android";
  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: !isAndroid,
          headerTintColor: props.tintColor,
          headerTitle: props.name,
          title: props.name,
          unstable_headerSubtitle: isAndroid ? undefined : props.subtitle,
        }}
      />
      {isAndroid ? (
        <AndroidScreenHeader
          title={props.name}
          subtitle={props.subtitle}
          onBack={() => {
            if (navigation.canGoBack()) navigation.goBack();
          }}
          actions={[
            { accessibilityLabel: "Save ZIP", icon: "square.and.arrow.up", onPress: props.onSave },
            ...(props.onRemove
              ? [
                  {
                    accessibilityLabel: "Remove from draft",
                    icon: "trash" as const,
                    onPress: props.onRemove,
                    destructive: true,
                    overflowOnly: true,
                  },
                ]
              : []),
          ]}
        />
      ) : (
        <Toolbar placement="right">
          {props.onRemove ? (
            <Toolbar.Menu accessibilityLabel="ZIP actions" icon="ellipsis">
              <Toolbar.MenuAction icon="square.and.arrow.up" onPress={props.onSave}>
                Save ZIP
              </Toolbar.MenuAction>
              <Toolbar.MenuAction icon="trash" destructive onPress={props.onRemove}>
                Remove from draft
              </Toolbar.MenuAction>
            </Toolbar.Menu>
          ) : (
            <Toolbar.Button
              accessibilityLabel="Save ZIP"
              icon="square.and.arrow.up"
              onPress={props.onSave}
            />
          )}
        </Toolbar>
      )}
    </>
  );
}

function ZipArchiveProgress(props: {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly timeLeft: string | null;
  readonly onCancel: () => void;
}) {
  const { timeLeft } = props;
  return (
    <View className="flex-1 justify-center gap-3 bg-sheet px-8">
      <Text className="text-xl font-t3-semibold text-foreground">
        {formatAttachmentSize(props.receivedBytes)}
        {props.totalBytes > 0 ? (
          <Text className="text-xl text-foreground-muted">
            {` of ${formatAttachmentSize(props.totalBytes)}`}
          </Text>
        ) : null}
      </Text>
      <Progress
        value={props.totalBytes > 0 ? props.receivedBytes / props.totalBytes : undefined}
        label="ZIP download progress"
      />
      <Text className="text-sm text-foreground-muted">
        {`Downloading the ZIP so its files can be listed.${timeLeft ? ` ${timeLeft} on this connection.` : ""}`}
      </Text>
      <Button label="Cancel" onPress={props.onCancel} />
    </View>
  );
}

function ZipArchiveFailure(props: {
  readonly failure: { title: string; detail: string; retry: boolean };
  readonly onRetry: () => void;
  readonly onSave: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        variant="plain"
        title={props.failure.title}
        detail={props.failure.detail}
        action={
          <View className="flex-row gap-3">
            {props.failure.retry ? (
              <Button tone="primary" label="Try again" onPress={props.onRetry} />
            ) : null}
            <Button
              tone={props.failure.retry ? "secondary" : "primary"}
              label="Save ZIP"
              onPress={props.onSave}
            />
          </View>
        }
      />
    </View>
  );
}

function ZipArchiveList(props: {
  readonly archive: ZipArchive;
  readonly headerInset: number;
  readonly onOpen: (entry: ZipPreviewEntry) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { archive } = props;
  const rows = flattenZipTree(buildZipTree(archive.entries), collapsed, query);
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const fileCount = archive.fileCount;
  return (
    <View className="flex-1 bg-sheet">
      <LegendList
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        contentInsetStartAdjustment={props.headerInset}
        className="flex-1"
        data={rows}
        keyExtractor={(row) => `${row.node.entry ? "f" : "d"}:${row.node.path}`}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
        estimatedItemSize={44}
        recycleItems
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        extraData={collapsed}
        contentContainerStyle={{ paddingBottom: 4 }}
        ListHeaderComponent={
          <View className="px-4 pt-3 pb-2.5">
            <View className="h-[38px] flex-row items-center gap-2 rounded-[10px] bg-subtle px-3">
              <SymbolView name="magnifyingglass" size={15} tintColorClassName="accent-icon-muted" />
              <TextInput
                accessibilityLabel="Filter files in ZIP"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={`Filter ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
                placeholderTextColorClassName="accent-placeholder"
                cursorColorClassName="accent-focus"
                className="min-w-0 flex-1 font-sans text-[15px] text-foreground"
                value={query}
                onChangeText={setQuery}
              />
              {query ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear filter"
                  hitSlop={10}
                  onPress={() => setQuery("")}
                >
                  <SymbolView
                    name="xmark.circle.fill"
                    size={16}
                    tintColorClassName="accent-icon-muted"
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <ZipTreeRowView
            row={item}
            collapsed={collapsed.has(item.node.path)}
            onToggle={toggle}
            onOpen={props.onOpen}
          />
        )}
        ListEmptyComponent={
          query ? (
            <EmptyState
              variant="plain"
              title={`No files match “${query.trim()}”`}
              detail="The filter checks file names and folder paths."
              action={<Button label="Clear filter" onPress={() => setQuery("")} />}
            />
          ) : (
            <EmptyState variant="plain" title="This ZIP is empty" detail="It has no files." />
          )
        }
      />
      {archive.hiddenCount > 0 ? (
        <View
          className="items-center border-t border-border pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <Text className="text-2xs text-foreground-muted">
            {`${archive.hiddenCount} macOS ${archive.hiddenCount === 1 ? "file" : "files"} hidden`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function ZipArchiveView(props: {
  readonly name: string;
  readonly subtitle: string;
  readonly tintColor: string;
  readonly sizeBytes: number;
  readonly uri: string | null;
  readonly isLocal: boolean;
  readonly refresh: () => Promise<string | null>;
  readonly environmentId: EnvironmentId | null;
  readonly draftKey: string | null;
  readonly maxAttachmentBytes: number | undefined;
  readonly onSave: () => void;
  readonly onRemove: (() => void) | null;
}) {
  const { state, retry, cancel } = useZipArchive(props);
  const [selection, setSelection] = useState<{
    readonly entries: ZipArchive["entries"];
    readonly entry: ZipPreviewEntry;
  } | null>(null);
  const archive = state.status === "ready" ? state.archive : null;
  const selected = selection && selection.entries === archive?.entries ? selection.entry : null;
  const entryOpen = selected !== null;
  usePreventRemove(entryOpen, () => setSelection(null));
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const headerInset = Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  return (
    <View className="flex-1 bg-sheet">
      {entryOpen ? null : (
        <ZipArchiveHeader
          name={props.name}
          subtitle={
            archive
              ? `${archive.fileCount} ${archive.fileCount === 1 ? "file" : "files"}${props.sizeBytes > 0 ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}`
              : props.subtitle
          }
          tintColor={props.tintColor}
          onSave={props.onSave}
          onRemove={props.onRemove}
        />
      )}
      {state.status === "ready" ? (
        <ZipArchiveList
          archive={state.archive}
          headerInset={headerInset}
          onOpen={(entry) => {
            Keyboard.dismiss();
            setSelection({ entries: state.archive.entries, entry });
          }}
        />
      ) : (
        <View className="flex-1" style={{ paddingTop: headerInset }}>
          {state.status === "loading" ? (
            props.isLocal || state.receivedBytes === 0 ? (
              <FilePreviewLoading message="Opening ZIP..." />
            ) : (
              <ZipArchiveProgress
                receivedBytes={state.receivedBytes}
                totalBytes={props.sizeBytes}
                timeLeft={state.timeLeft}
                onCancel={cancel}
              />
            )
          ) : (
            <ZipArchiveFailure
              failure={archiveFailure(state.reason)}
              onRetry={retry}
              onSave={props.onSave}
            />
          )}
        </View>
      )}
      {selected && archive ? (
        <View className="absolute inset-0">
          <ZipEntryView
            archiveName={props.name}
            archive={archive}
            entry={selected}
            environmentId={props.environmentId}
            draftKey={props.draftKey}
            maxAttachmentBytes={props.maxAttachmentBytes}
            onBack={() => setSelection(null)}
          />
        </View>
      ) : null}
    </View>
  );
}

async function addZipEntryToDraft(input: {
  readonly archive: ZipArchive;
  readonly entry: ZipPreviewEntry;
  readonly draftKey: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}) {
  const { entry, signal } = input;
  const mimeType = entry.mimeType ?? "application/octet-stream";
  const file = await writeGeneratedAttachmentFile({
    bytes: await input.archive.readFileForSave(entry, signal),
    attachment: { name: entry.name, mimeType },
  });
  try {
    signal.throwIfAborted();
    const attachment = await createComposerFileAttachment({
      uri: file.uri,
      name: entry.name,
      mimeType,
      sizeBytes: entry.sizeBytes,
      maxBytes: input.maxBytes,
    });
    signal.throwIfAborted();
    if (appendComposerDraftAttachments(input.draftKey, [attachment], { appendReference: true }))
      throw new Error("This message already has as many attachments as it can hold.");
  } finally {
    file.dispose();
  }
}

type EntryContent =
  | { readonly status: "loading" }
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "file"; readonly uri: string }
  | { readonly status: "failed"; readonly reason: ZipFailure; readonly message: string };

function ZipEntryView(props: {
  readonly archiveName: string;
  readonly archive: ZipArchive;
  readonly entry: ZipPreviewEntry;
  readonly environmentId: EnvironmentId | null;
  readonly draftKey: string | null;
  readonly maxAttachmentBytes: number | undefined;
  readonly onBack: () => void;
}) {
  const { archive, entry, draftKey, maxAttachmentBytes } = props;
  const mimeType = entry.mimeType ?? "application/octet-stream";
  const previewKind = filePreviewKind({ name: entry.name, mimeType });
  const isText = previewKind === "text" || previewKind === "markdown" || previewKind === "html";
  // Archive HTML is shown as source: a rendered page could load its sibling files.
  const kind = previewKind === "html" ? "text" : previewKind;
  const [content, setContent] = useState<EntryContent>({ status: "loading" });
  const [prefixRequested, setPrefixRequested] = useState(false);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "attach" | null>(null);
  const action = useRef<AbortController | null>(null);
  const pendingViewerError = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Cancel a pending save or attach when the entry closes.
  useEffect(() => () => action.current?.abort(), []);
  // oxlint-disable-next-line t3code/react-effect-budget -- Read the selected entry and release its cached file on cleanup.
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    // oxlint-disable-next-line react/set-state-in-effect -- A new entry clears the previous preview.
    setContent({ status: "loading" });
    void (async (): Promise<EntryContent> => {
      if (isText && prefixRequested) {
        const prefix = await archive.readTextPrefix(entry, controller.signal);
        return { status: "text", ...decodeFilePreviewText(prefix.bytes, prefix.truncated) };
      }
      const bytes = await archive.readFile(entry, controller.signal);
      if (isText) return { status: "text", ...decodeFilePreviewText(bytes) };
      const file = await writeGeneratedAttachmentFile({
        bytes,
        attachment: { name: entry.name, mimeType },
      });
      if (controller.signal.aborted) {
        file.dispose();
        controller.signal.throwIfAborted();
      }
      release = file.dispose;
      return { status: "file", uri: file.uri };
    })()
      .then((value) => {
        if (!controller.signal.aborted) setContent(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setContent({
            status: "failed",
            reason: failureReason(cause),
            message: errorMessage(cause, "Could not read this file."),
          });
      });
    return () => {
      controller.abort();
      release?.();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reread the entry.
  }, [archive, entry, isText, mimeType, prefixRequested, revision]);

  const run = (kind: "save" | "attach", task: (signal: AbortSignal) => Promise<unknown>) => {
    if (busy) return;
    setBusy(kind);
    const controller = new AbortController();
    action.current = controller;
    void task(controller.signal).then(
      () => {
        if (controller.signal.aborted) return;
        setBusy(null);
        if (kind === "attach")
          Dialog.alert("Added to chat", `${entry.name} is attached to your message.`);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setBusy(null);
        Dialog.alert(
          kind === "save" ? "Could not save file" : "Could not add file to chat",
          errorMessage(cause, "Please try again."),
        );
      },
    );
  };
  const save = () =>
    run("save", async (signal) =>
      shareGeneratedAttachment({
        bytes: await archive.readFileForSave(entry, signal),
        attachment: { name: entry.name, mimeType },
        signal,
      }),
    );
  const canAddToChat = draftKey !== null && maxAttachmentBytes !== undefined;
  const addToChat = () => {
    if (draftKey === null || maxAttachmentBytes === undefined) return;
    run("attach", (signal) =>
      addZipEntryToDraft({ archive, entry, draftKey, maxBytes: maxAttachmentBytes, signal }),
    );
  };

  const text = content.status === "text" ? content : null;
  const delimiter = filePreviewDelimiter({ name: entry.name, mimeType });
  const table = text && delimiter ? parseDelimitedPreview(text.text, delimiter) : null;
  const uri = content.status === "file" ? content.uri : null;
  const { renderedMode, activeMode } = attachmentDocumentPresentation({
    kind,
    hasTable: table !== null,
    hasEnvironment: props.environmentId !== null,
    rendered,
  });
  const failure = content.status === "failed" ? content : null;
  const tooBig = failure?.reason === "file-limit" && isText && !prefixRequested;
  const folders = entry.path.split("/").slice(0, -1);
  const subtitle = `${[props.archiveName, ...folders].join(" / ")} · ${formatAttachmentSize(entry.sizeBytes)}`;
  const isAndroid = Platform.OS === "android";
  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: !isAndroid,
          headerTitle: entry.name,
          title: entry.name,
          unstable_headerSubtitle: isAndroid ? undefined : subtitle,
        }}
      />
      {isAndroid ? (
        <AndroidScreenHeader
          title={entry.name}
          subtitle={subtitle}
          onBack={props.onBack}
          actions={[
            ...(renderedMode
              ? [
                  {
                    accessibilityLabel: rendered ? "Show source" : "Show preview",
                    icon: rendered ? ("doc.text" as const) : ("eye" as const),
                    onPress: () => setRendered((value) => !value),
                  },
                ]
              : []),
            ...(canAddToChat
              ? [
                  {
                    accessibilityLabel: "Add to chat",
                    icon: "plus.bubble" as const,
                    onPress: addToChat,
                    disabled: busy !== null,
                  },
                ]
              : []),
            {
              accessibilityLabel: "Save file",
              icon: "square.and.arrow.up",
              onPress: save,
              loading: busy === "save",
            },
          ]}
        />
      ) : (
        <Toolbar placement="right">
          <Toolbar.Menu accessibilityLabel="File actions" icon="ellipsis">
            {renderedMode ? (
              <Toolbar.MenuAction
                icon={rendered ? "doc.text" : "eye"}
                onPress={() => setRendered((value) => !value)}
              >
                {rendered ? "Show source" : "Show preview"}
              </Toolbar.MenuAction>
            ) : null}
            {canAddToChat ? (
              <Toolbar.MenuAction icon="plus.bubble" disabled={busy !== null} onPress={addToChat}>
                Add to chat
              </Toolbar.MenuAction>
            ) : null}
            <Toolbar.MenuAction icon="square.and.arrow.up" disabled={busy !== null} onPress={save}>
              Save file
            </Toolbar.MenuAction>
          </Toolbar.Menu>
        </Toolbar>
      )}
      {failure ? (
        <ScrollView contentContainerClassName="flex-grow items-center justify-center px-6">
          <EmptyState
            variant="plain"
            title={
              tooBig
                ? "Too big to preview in full"
                : failure.reason === "image-limit"
                  ? "Too large to preview safely"
                  : failure.reason === "file-limit"
                    ? "Too big to preview"
                    : "Couldn't read this file"
            }
            detail={
              tooBig
                ? "Previews stop at 10 MB. You can read the start of the file or save the whole file."
                : failure.reason === "image-limit"
                  ? "It could freeze the app, so it isn't decoded. Save it to view it in another app."
                  : failure.message
            }
            action={
              <View className="flex-row gap-3">
                {tooBig ? (
                  <Button
                    tone="primary"
                    label="Show first 1 MB"
                    onPress={() => setPrefixRequested(true)}
                  />
                ) : null}
                <Button
                  tone={tooBig ? "secondary" : "primary"}
                  label="Save file"
                  loading={busy === "save"}
                  onPress={save}
                />
              </View>
            }
          />
        </ScrollView>
      ) : (
        <AttachmentDocumentBody
          document={{
            kind,
            activeMode,
            uri,
            content: text,
            table,
            error: null,
            needsText: isText,
            retry: () => setRevision((value) => value + 1),
            revision,
          }}
          name={entry.name}
          environmentId={props.environmentId}
          htmlRender={false}
          nativeViewer={uri ? (viewerError ? "unavailable" : "open") : isText ? null : "pending"}
          nativeError={viewerError}
          onOpenNative={() => setViewerError(null)}
        />
      )}
      {uri && !viewerError ? (
        <FilePreviewModal
          source={{
            kind: kind === "image" ? "image" : kind === "pdf" ? "pdf" : "document",
            name: entry.name,
            mimeType,
            uri,
          }}
          onOpenError={(error) => {
            pendingViewerError.current = nativeViewerErrorMessage(error);
          }}
          onRequestClose={() => {
            const message = pendingViewerError.current;
            pendingViewerError.current = null;
            if (message) setViewerError(message);
            else props.onBack();
          }}
        />
      ) : null}
    </View>
  );
}
