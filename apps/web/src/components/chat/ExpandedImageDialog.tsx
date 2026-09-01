import { memo, useCallback, useEffect, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ImageIcon,
  TextIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { downloadVideoPreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  WindowCaptureContentsButton,
  windowCaptureAccessibilityText,
} from "./WindowCaptureAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedVideoSrc, setFailedVideoSrc] = useState<string | null>(null);
  const [downloadingVideoSrc, setDownloadingVideoSrc] = useState<string | null>(null);
  const [downloadFailedVideoSrc, setDownloadFailedVideoSrc] = useState<string | null>(null);
  const [accessibilityTextSrc, setAccessibilityTextSrc] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  const downloadVideo = async (src: string, name: string) => {
    setDownloadFailedVideoSrc(null);
    setDownloadingVideoSrc(src);
    try {
      await downloadVideoPreview(src, name);
    } catch {
      setDownloadFailedVideoSrc(src);
    } finally {
      setDownloadingVideoSrc((current) => (current === src ? null : current));
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  const item = preview.images[index];
  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";

  const isDownloadingVideo = downloadingVideoSrc === item.src;
  const videoDownloadFailed = downloadFailedVideoSrc === item.src;
  const accessibilityText = item.source ? windowCaptureAccessibilityText(item.source) : undefined;
  const showingAccessibilityText = Boolean(accessibilityText) && accessibilityTextSrc === item.src;
  const contentsLabel = showingAccessibilityText ? "Show screenshot" : "Show extracted text";
  const ContentsIcon = showingAccessibilityText ? ImageIcon : TextIcon;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={`Expanded ${mediaLabel} preview`}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label={`Close ${mediaLabel} preview`}
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label={`Close ${mediaLabel} preview`}
        >
          <XIcon />
        </Button>
        {item.type === "video" && failedVideoSrc === item.src ? (
          <div className="flex h-48 w-[min(92vw,32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black px-6 text-center text-white shadow-2xl">
            <p className="text-sm">
              {videoDownloadFailed
                ? "Could not download this video."
                : "This video format cannot be played here."}
            </p>
            <Button
              size="sm"
              variant="secondary"
              aria-busy={isDownloadingVideo || undefined}
              aria-disabled={isDownloadingVideo || undefined}
              onClick={() => {
                if (isDownloadingVideo) return;
                void downloadVideo(item.src, item.name);
              }}
            >
              <DownloadIcon />
              {isDownloadingVideo ? "Downloading…" : "Download video"}
            </Button>
          </div>
        ) : item.type === "video" ? (
          <video
            src={item.src}
            aria-label={item.name}
            autoPlay
            controls
            playsInline
            onError={() => setFailedVideoSrc(item.src)}
            className="max-h-[86vh] max-w-[92vw] rounded-lg border border-border/70 bg-black object-contain shadow-2xl"
          />
        ) : showingAccessibilityText ? (
          <pre
            className="h-[min(86vh,40rem)] w-[min(92vw,42rem)] animate-[window-capture-contents-enter_140ms_ease-out] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-background p-4 font-mono text-xs leading-5 shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 motion-reduce:animate-none"
            tabIndex={0}
          >
            {accessibilityText}
          </pre>
        ) : (
          <img
            src={item.src}
            alt={item.name}
            className="max-h-[86vh] max-w-[92vw] animate-[window-capture-contents-enter_140ms_ease-out] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl motion-reduce:animate-none"
            draggable={false}
          />
        )}
        <div className="mt-2 flex max-w-[92vw] items-center justify-center gap-1.5 text-xs text-muted-foreground/80">
          <span className="truncate">
            {item.name}
            {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
          </span>
          {accessibilityText && item.source ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={contentsLabel}
                    aria-pressed={showingAccessibilityText}
                    className="[--control-icon-color:currentColor] hover:bg-white/10 hover:text-white"
                    onClick={() =>
                      setAccessibilityTextSrc(showingAccessibilityText ? null : item.src)
                    }
                    size="icon-micro"
                    variant="ghost-muted"
                  />
                }
              >
                <ContentsIcon className="size-3" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
            </Tooltip>
          ) : item.source ? (
            <WindowCaptureContentsButton
              source={item.source}
              side="top"
              className="hover:bg-white/10 hover:text-white"
            />
          ) : null}
        </div>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
