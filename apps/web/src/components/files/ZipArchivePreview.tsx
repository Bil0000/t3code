import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTheme } from "~/hooks/useTheme";
import { loadZipPreview, readZipPreviewResponse, type ZipPreviewEntry } from "~/lib/zipPreview";

import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

type ZipArchive = Awaited<ReturnType<typeof loadZipPreview>>;

function parentFolder(path: string) {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function itemCount(count: number) {
  return count === 1 ? "1 item" : `${count.toLocaleString()} items`;
}

function useZipImageUrl(archive: ZipArchive, entry: ZipPreviewEntry, enabled: boolean) {
  const [image, setImage] = useState<{ url: string | null; error: string | null }>({
    url: null,
    error: null,
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let url: string | null = null;
    archive.readImage(entry, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage({ url, error: null });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setImage({ url: null, error: errorMessage(cause, "Could not read this image.") });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      setImage({ url: null, error: null });
    };
  }, [archive, entry, enabled]);
  return image;
}

function ZipImageTile(props: {
  readonly archive: ZipArchive;
  readonly entry: ZipPreviewEntry;
  readonly theme: "light" | "dark";
  readonly onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setVisible(last.isIntersecting);
      },
      { rootMargin: "200px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const image = useZipImageUrl(props.archive, props.entry, visible);
  const showImage = image.url !== null && !failed;
  return (
    <button
      ref={ref}
      type="button"
      onClick={props.onOpen}
      aria-label={`Open ${props.entry.name}`}
      className="flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border border-border/60 bg-card text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted/40">
        {showImage ? (
          <img
            src={image.url ?? undefined}
            alt=""
            decoding="async"
            draggable={false}
            className="size-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <PierreEntryIcon
            pathValue={props.entry.path}
            kind="file"
            theme={props.theme}
            className="size-8"
          />
        )}
      </span>
      <ZipTileCaption
        name={props.entry.name}
        detail={
          image.error || failed
            ? "Preview unavailable"
            : formatAttachmentSize(props.entry.sizeBytes)
        }
      />
    </button>
  );
}

function ZipTileCaption(props: { readonly name: string; readonly detail: string }) {
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5 border-t border-border/60 px-2 py-1.5">
      <span className="flex min-w-0 text-xs font-medium text-foreground">
        <MiddleTruncate value={props.name} />
      </span>
      <span className="truncate text-2xs text-muted-foreground">{props.detail}</span>
    </span>
  );
}

function ZipImageViewer(props: { readonly archive: ZipArchive; readonly entry: ZipPreviewEntry }) {
  const image = useZipImageUrl(props.archive, props.entry, true);
  const [failed, setFailed] = useState(false);
  if (image.error || failed) {
    return <FileSurfaceFailure message={image.error ?? "Unable to load image."} />;
  }
  if (!image.url) return <FileSurfaceLoading />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <img
        src={image.url}
        alt={props.entry.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function ZipArchiveBrowser(props: { readonly name: string; readonly archive: ZipArchive }) {
  const { resolvedTheme } = useTheme();
  const [folder, setFolder] = useState("");
  const [viewing, setViewing] = useState<ZipPreviewEntry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = (nextFolder: string, nextViewing: ZipPreviewEntry | null = null) => {
    rootRef.current?.focus({ preventScroll: true });
    setFolder(nextFolder);
    setViewing(nextViewing);
  };
  const childrenByFolder = useMemo(() => {
    const groups = new Map<string, ZipPreviewEntry[]>();
    for (const entry of props.archive.entries) {
      const parent = parentFolder(entry.path);
      const group = groups.get(parent);
      if (group) group.push(entry);
      else groups.set(parent, [entry]);
    }
    return groups;
  }, [props.archive]);
  const children = childrenByFolder.get(folder) ?? [];
  const folders = children.filter((entry) => entry.isDirectory);
  const files = children.filter((entry) => !entry.isDirectory);
  const segments = folder.split("/").filter(Boolean);
  const canGoBack = viewing !== null || folder !== "";
  const goBack = () => navigate(viewing ? folder : parentFolder(folder));
  const onKeyDown = (event: KeyboardEvent) => {
    if (!canGoBack || (event.key !== "Escape" && event.key !== "Backspace")) return;
    event.preventDefault();
    event.stopPropagation();
    goBack();
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={onKeyDown}
    >
      <nav
        aria-label="Archive location"
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-xs"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={goBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <ZipCrumb
            label={props.name}
            current={segments.length === 0 && viewing === null}
            onSelect={() => navigate("")}
          />
          {segments.map((segment, index) => (
            <Fragment key={segments.slice(0, index + 1).join("/")}>
              <ChevronRightIcon className="mx-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
              <ZipCrumb
                label={segment}
                current={index === segments.length - 1 && viewing === null}
                onSelect={() => navigate(`${segments.slice(0, index + 1).join("/")}/`)}
              />
            </Fragment>
          ))}
          {viewing ? (
            <>
              <ChevronRightIcon className="mx-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
              <ZipCrumb label={viewing.name} current onSelect={() => undefined} />
            </>
          ) : null}
        </div>
        {viewing ? null : (
          <span className="shrink-0 px-1 text-muted-foreground">{itemCount(children.length)}</span>
        )}
      </nav>
      {viewing ? (
        <ZipImageViewer key={viewing.path} archive={props.archive} entry={viewing} />
      ) : children.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {folder ? "This folder is empty." : "This archive is empty."}
        </div>
      ) : (
        <ScrollArea key={folder} className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-3">
            {folders.length > 0 ? (
              <section aria-label="Folders">
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
                  {folders.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => navigate(entry.path)}
                        className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <PierreEntryIcon
                          pathValue={entry.path}
                          kind="directory"
                          theme={resolvedTheme}
                        />
                        <span className="flex min-w-0 flex-1 font-medium">
                          <MiddleTruncate value={entry.name} />
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {childrenByFolder.get(entry.path)?.length ?? 0}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {files.length > 0 ? (
              <section aria-label="Files">
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
                  {files.map((entry) => (
                    <li key={entry.path}>
                      {entry.mimeType ? (
                        <ZipImageTile
                          archive={props.archive}
                          entry={entry}
                          theme={resolvedTheme}
                          onOpen={() => navigate(folder, entry)}
                        />
                      ) : (
                        <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
                          <span className="flex aspect-[4/3] w-full items-center justify-center bg-muted/40">
                            <PierreEntryIcon
                              pathValue={entry.path}
                              kind="file"
                              theme={resolvedTheme}
                              className="size-8"
                            />
                          </span>
                          <ZipTileCaption
                            name={entry.name}
                            detail={formatAttachmentSize(entry.sizeBytes)}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ZipCrumb(props: {
  readonly label: string;
  readonly current: boolean;
  readonly onSelect: () => void;
}) {
  return props.current ? (
    <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
      {props.label}
    </span>
  ) : (
    <button
      type="button"
      onClick={props.onSelect}
      className="relative block max-w-40 min-w-0 shrink cursor-pointer truncate rounded-sm px-0.5 text-left text-muted-foreground outline-none pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-3 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {props.label}
    </button>
  );
}

export default function ZipArchivePreview(props: {
  readonly name: string;
  readonly file: Blob | null;
  readonly url: string;
  readonly onRetry: () => void;
}) {
  const [archive, setArchive] = useState<ZipArchive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { file, url } = props;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const blob =
        file ??
        (await readZipPreviewResponse(
          await fetch(url, { signal: controller.signal }),
          controller.signal,
        ));
      const loaded = await loadZipPreview(blob, controller.signal);
      if (!controller.signal.aborted) setArchive(loaded);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause, "Could not read this ZIP."));
    });
    return () => controller.abort();
  }, [file, url]);

  if (error) return <FileSurfaceFailure message={error} onRetry={props.onRetry} />;
  if (!archive) return <FileSurfaceLoading />;
  return <ZipArchiveBrowser name={props.name} archive={archive} />;
}
