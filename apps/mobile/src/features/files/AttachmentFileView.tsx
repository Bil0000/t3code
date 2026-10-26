import * as Dialog from "../../components/ui/Dialog";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AudioFilePreview } from "./AudioFilePreview";
import { DelimitedFilePreview } from "./DelimitedFilePreview";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import type { useAttachmentDocument } from "../../lib/attachmentDocument";
import { nativeViewerErrorMessage } from "../../lib/attachmentDownload";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { FileHeader } from "./FileHeader";
import { FilePreviewLoading, FilePreviewNotice } from "./FilePreviewFeedback";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SourceFileSurface } from "./SourceFileSurface";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import { HtmlRenderWebView } from "../threads/HtmlRenderWebView";

export type FileViewerDocument = Pick<
  ReturnType<typeof useAttachmentDocument>,
  | "kind"
  | "renderedMode"
  | "activeMode"
  | "uri"
  | "content"
  | "table"
  | "error"
  | "needsText"
  | "setRendered"
  | "retry"
  | "revision"
  | "share"
  | "sharing"
>;

type NativeViewerState = "pending" | "open" | "unavailable" | null;

function nativeViewerKind(kind: FileViewerDocument["kind"]) {
  if (kind === "image") return "image" as const;
  if (kind === "pdf") return "pdf" as const;
  if (kind === "video" || kind === "unsupported") return "document" as const;
  return null;
}

function AttachmentFileBody(props: {
  readonly document: FileViewerDocument;
  readonly name: string;
  readonly environmentId: EnvironmentId | null;
  readonly htmlRender: boolean;
  readonly nativeViewer: NativeViewerState;
  readonly nativeError: string | null;
  readonly canOpenNative: boolean;
  readonly onOpenNative: () => void;
  readonly failure?: ReactNode;
}) {
  const { document } = props;
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  if (props.failure) return props.failure;
  if (document.error) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title="File unavailable"
          detail={document.error}
          actionLabel="Try again"
          onAction={document.retry}
        />
      </View>
    );
  }
  if (props.nativeViewer !== null && props.nativeViewer !== "unavailable") {
    return <FilePreviewLoading message="Opening in file viewer..." />;
  }
  if (document.needsText && document.content) {
    const { content, table } = document;
    const reservedHeaderInset =
      Platform.OS === "ios" && content.truncated ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
    return (
      <View className="flex-1 bg-sheet" style={{ paddingTop: reservedHeaderInset }}>
        {content.truncated ? (
          <FilePreviewNotice title="Partial file">
            Preview limited to the first 1 MB. Save or share the file to read it in full.
          </FilePreviewNotice>
        ) : null}
        {table && document.activeMode === "table" ? (
          <DelimitedFilePreview table={table} />
        ) : document.activeMode === "markdown" && props.environmentId ? (
          <FileMarkdownPreview
            cwd=""
            relativePath=""
            environmentId={props.environmentId}
            threadId={null}
            markdown={content.text}
            captured
          />
        ) : (
          <SourceFileSurface
            selectable
            contents={content.text}
            path={props.name}
            headerInsetTop={content.truncated ? 0 : undefined}
          />
        )}
      </View>
    );
  }
  if (!document.uri || document.needsText) {
    return <FilePreviewLoading message="Loading file..." />;
  }
  if (document.kind === "audio") {
    return <AudioFilePreview key={document.revision} uri={document.uri} onRetry={document.retry} />;
  }
  if (document.kind === "html") {
    return props.htmlRender ? (
      <HtmlRenderWebView key={document.uri} uri={document.uri} title={props.name} nested={false} />
    ) : (
      <WorkspaceFileWebPreview uri={document.uri} />
    );
  }
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        title="No preview for this file"
        detail={
          props.nativeError ??
          (props.nativeViewer === null && props.canOpenNative
            ? "Open it in the file viewer, or save or share it to open it elsewhere."
            : "No app on this device can show this format. Save or share it to open it elsewhere.")
        }
        actionLabel={
          props.canOpenNative
            ? props.nativeViewer === null
              ? "Open in file viewer"
              : "Try again"
            : undefined
        }
        onAction={props.onOpenNative}
      />
    </View>
  );
}

export function AttachmentFileView(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly document: FileViewerDocument;
  readonly nativeSource: FilePreviewSource | null;
  readonly environmentId: EnvironmentId | null;
  readonly htmlRender: boolean;
  readonly addToChat: { readonly onPress: () => void; readonly busy: boolean } | null;
  readonly onRemove: (() => void) | null;
  readonly onBack: () => void;
  readonly failure?: ReactNode;
}) {
  const { document, nativeSource, onBack } = props;
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const iconColor = useUniwindTheme()["--color-icon"];
  const nativeKind = nativeViewerKind(document.kind);
  const [nativeOpen, setNativeOpen] = useState(false);
  const [nativeViewer, setNativeViewer] = useState<NativeViewerState>(
    nativeKind ? "pending" : null,
  );
  const [nativeError, setNativeError] = useState<string | null>(null);
  const pendingNativeError = useRef<string | null>(null);
  const { uri, content, renderedMode, activeMode, setRendered, share, sharing } = document;
  const hasNativeSource = nativeSource !== null;
  // oxlint-disable-next-line t3code/react-effect-budget -- Present the native file viewer after its source URL resolves.
  useEffect(() => {
    if (nativeViewer !== "pending" || !uri) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Presenting the viewer waits on the resolved file.
    setNativeViewer(hasNativeSource ? "open" : null);
    setNativeOpen(hasNativeSource);
  }, [nativeViewer, uri, hasNativeSource]);
  const openNative = () => {
    setNativeViewer((current) => (current === null ? null : "open"));
    setNativeOpen(true);
  };
  const handleNativeClose = () => {
    setNativeOpen(false);
    const message = pendingNativeError.current;
    pendingNativeError.current = null;
    if (nativeViewer === null) {
      if (message) Dialog.alert("Could not open document", message);
      return;
    }
    if (message) {
      setNativeError(message);
      setNativeViewer("unavailable");
      return;
    }
    setNativeError(null);
    if (props.addToChat) setNativeViewer(null);
    else onBack();
  };

  const canOpenNative = uri !== null && hasNativeSource;
  const actions = [
    renderedMode
      ? {
          id: "preview",
          title: renderedMode === "table" ? "Table" : "Preview",
          icon: renderedMode === "table" ? "tablecells" : "eye",
          inline: true,
          onPress: () => setRendered(true),
        }
      : null,
    renderedMode
      ? {
          id: "source",
          title: "Source",
          icon: "doc.text",
          inline: true,
          onPress: () => setRendered(false),
        }
      : null,
    content && activeMode === "source"
      ? {
          id: "word-wrap",
          title: appearance.codeWordBreak ? "Disable word wrap" : "Enable word wrap",
          icon: "text.alignleft",
          inline: false,
          onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
        }
      : null,
    props.addToChat
      ? {
          id: "add-to-chat",
          title: "Add to chat",
          icon: "plus.bubble",
          inline: false,
          disabled: props.addToChat.busy,
          onPress: props.addToChat.onPress,
        }
      : null,
    content
      ? {
          id: "copy",
          title: content.truncated ? "Copy preview" : "Copy contents",
          icon: "doc.on.doc",
          inline: false,
          onPress: () => copyTextWithHaptic(content.text),
        }
      : null,
    {
      id: "share",
      title: sharing ? "Opening share sheet…" : "Save or share",
      icon: "square.and.arrow.up",
      inline: false,
      disabled: sharing,
      onPress: () => void share(),
    },
    canOpenNative
      ? {
          id: "open-viewer",
          title: "Open in file viewer",
          icon: "arrow.up.left.and.arrow.down.right",
          inline: false,
          onPress: openNative,
        }
      : null,
    props.onRemove
      ? {
          id: "remove",
          title: "Remove from draft",
          icon: "trash",
          inline: false,
          destructive: true,
          onPress: props.onRemove,
        }
      : null,
  ].filter((action) => action !== null);

  return (
    <View className="flex-1 bg-sheet">
      <FileHeader
        title={props.title}
        subtitle={props.subtitle}
        iconColor={iconColor}
        activeMode={activeMode === "source" ? "source" : "preview"}
        onBack={onBack}
        actions={actions}
      />
      <ScreenContent>
        <AttachmentFileBody
          document={document}
          name={props.title}
          environmentId={props.environmentId}
          htmlRender={props.htmlRender}
          nativeViewer={nativeViewer}
          nativeError={nativeError}
          canOpenNative={canOpenNative}
          onOpenNative={openNative}
          failure={props.failure}
        />
      </ScreenContent>
      {nativeOpen && nativeSource ? (
        <FilePreviewModal
          source={nativeSource}
          onRequestClose={handleNativeClose}
          onOpenError={(error) => {
            pendingNativeError.current = nativeViewerErrorMessage(error);
          }}
        />
      ) : null}
    </View>
  );
}
