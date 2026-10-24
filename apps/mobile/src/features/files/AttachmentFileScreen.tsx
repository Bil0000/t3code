import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { View } from "react-native";

import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { useAttachmentDocument } from "../../lib/attachmentDocument";
import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import { isFileBackedComposerAttachment } from "../../lib/composerImages";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { removeComposerDraftAttachment, useComposerDraft } from "../../state/use-composer-drafts";
import { useEnvironmentServerConfig } from "../../state/entities";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { questionAttachmentDraftPrefix } from "../../state/question-attachments";
import { AttachmentFileView } from "./AttachmentFileView";
import { useFileActions } from "./useFileActions";
import { ZipArchiveView } from "./ZipArchiveView";
import { addFileToDraft } from "./zipEntryActions";
import { isZipAttachment } from "./zipTree";

export type AttachmentFileRouteParams = {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly draftKey?: string;
  readonly htmlRender?: "1";
};

type AttachmentFileScreenProps = StaticScreenProps<AttachmentFileRouteParams>;

function nativeViewerKind(kind: ReturnType<typeof useAttachmentDocument>["kind"]) {
  if (kind === "image") return "image" as const;
  if (kind === "pdf") return "pdf" as const;
  return "document" as const;
}

export function AttachmentFileScreen(props: AttachmentFileScreenProps) {
  const navigation = useNavigation();
  const iconColor = useUniwindTheme()["--color-icon"];
  const params = props.route.params;
  const environmentId = params.environmentId?.trim()
    ? EnvironmentId.make(params.environmentId)
    : null;
  const threadId = params.threadId ? ThreadId.make(params.threadId) : null;
  const sizeBytes = Number.parseInt(params.sizeBytes, 10) || 0;
  const draftKey = params.draftKey ?? null;
  const draft = useComposerDraft(draftKey);
  const draftAttachment = draftKey
    ? draft.attachments.find((entry) => entry.id === params.attachmentId)
    : undefined;
  const localAttachment =
    draftAttachment && isFileBackedComposerAttachment(draftAttachment) ? draftAttachment : null;
  const document = useAttachmentDocument({
    name: params.name,
    mimeType: params.mimeType,
    sizeBytes,
    attachmentId: params.attachmentId,
    environmentId,
    attachment: localAttachment,
  });
  const { busy, run } = useFileActions(params.name);
  const isZip = isZipAttachment(params);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const maxAttachmentBytes = serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes;
  const threadDraftKey =
    environmentId && threadId ? scopedThreadKey(environmentId, threadId) : null;
  const handleBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };
  const { uri, resource, refresh } = document;
  // The viewer mints its own fresh URL from the resource, so a link that expired while this
  // screen sat in the background is never handed to Quick Look or ACTION_VIEW.
  const nativeSource = ((): FilePreviewSource | null => {
    const base = {
      kind: nativeViewerKind(document.kind),
      name: params.name,
      mimeType: params.mimeType,
    };
    if (localAttachment) return { ...base, attachment: localAttachment };
    if (environmentId) return { ...base, environmentId, resource };
    return uri ? { ...base, uri } : null;
  })();
  const removeFromDraft = () => {
    if (!draftKey) return;
    removeComposerDraftAttachment(draftKey, params.attachmentId);
    handleBack();
  };
  const subtitle = `${draftKey ? "Draft attachment" : "Attachment"}${sizeBytes > 0 ? ` · ${formatAttachmentSize(sizeBytes)}` : ""}`;

  if (isZip && !document.error) {
    const questionPrefix =
      environmentId && threadId ? questionAttachmentDraftPrefix(environmentId, threadId) : null;
    return (
      <View className="flex-1 bg-sheet">
        <ZipArchiveView
          name={params.name}
          subtitle={subtitle}
          tintColor={iconColor}
          sizeBytes={sizeBytes}
          uri={uri}
          isLocal={localAttachment !== null}
          refresh={refresh}
          environmentId={environmentId}
          draftKey={draftKey ?? threadDraftKey}
          questionPrefix={
            questionPrefix && draftKey?.startsWith(questionPrefix) ? questionPrefix : null
          }
          maxAttachmentBytes={maxAttachmentBytes}
          onSave={() => void document.share()}
          onRemove={draftKey ? removeFromDraft : null}
        />
      </View>
    );
  }

  return (
    <AttachmentFileView
      title={params.name}
      subtitle={subtitle}
      document={document}
      nativeSource={nativeSource}
      environmentId={environmentId}
      htmlRender={params.htmlRender === "1"}
      addToChat={
        draftKey === null && threadDraftKey !== null && maxAttachmentBytes !== undefined
          ? {
              busy: busy !== null,
              onPress: () =>
                run("attach", (signal) =>
                  addFileToDraft({
                    name: params.name,
                    mimeType: params.mimeType,
                    sizeBytes: sizeBytes > 0 ? sizeBytes : null,
                    draftKey: threadDraftKey,
                    questionPrefix: null,
                    maxBytes: maxAttachmentBytes,
                    signal,
                    open: async (openSignal) => {
                      const url = await refresh();
                      if (!url) throw new Error("Reconnect to this environment and try again.");
                      return downloadAttachmentForPreview({
                        url,
                        attachment: { name: params.name, mimeType: params.mimeType },
                        signal: openSignal,
                      });
                    },
                  }),
                ),
            }
          : null
      }
      onRemove={draftKey ? removeFromDraft : null}
      onBack={handleBack}
    />
  );
}
