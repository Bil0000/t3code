import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GripVerticalIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  removePane,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
} from "~/chatPanes.logic";
import {
  chatPaneDragPointer,
  isChatPaneDragActive,
  useChatPaneDragStore,
} from "~/chatPaneDragStore";
import {
  commitChatPaneDrop,
  selectPaneDropZoneResolver,
  useChatPanesStore,
} from "~/chatPanesStore";
import ChatView from "~/components/ChatView";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadDetail, useThreadShell, useThreadStatus } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import { ChatPaneDropOverlay } from "./ChatPaneDropOverlay";
import { ChatPaneResizeHandle } from "./ChatPaneResizeHandle";

const DRAG_DISTANCE = 6;

/**
 * Renders the split layout. Every leaf mounts its own ChatView; the route
 * thread is the focused pane and owns the shortcuts and autofocus that must
 * only fire once per window. Clicking into another pane navigates to its
 * thread, which moves the focus ring without touching the layout.
 */
export function ChatPanes({
  root,
  routeThreadRef,
}: {
  root: ChatPaneNode;
  routeThreadRef: ScopedThreadRef;
}) {
  const navigate = useNavigate();
  const focusPane = useChatPanesStore((state) => state.focusPane);
  const showThread = useChatPanesStore((state) => state.showThread);
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const routeLeaf = useMemo(() => findLeaf(root, routeThreadKey), [root, routeThreadKey]);

  // The route is the focused pane. A navigation to a thread outside the
  // layout (sidebar, palette, shortcut) takes over the focused pane rather
  // than tearing the layout down.
  useEffect(() => {
    if (routeLeaf) focusPane(routeLeaf.id);
    else showThread(routeThreadRef);
  }, [focusPane, routeLeaf, routeThreadRef, showThread]);

  const follow = useCallback(
    (threadRef: ScopedThreadRef | null) => {
      if (!threadRef) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
      });
    },
    [navigate],
  );

  const activate = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (scopedThreadKey(threadRef) === routeThreadKey) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate, routeThreadKey],
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 bg-background"
      data-chat-panes
      onPointerUpCapture={() => {
        if (!isChatPaneDragActive()) return;
        // The gesture owner's document listeners already ran; defer the
        // layout change so React finishes this event untouched.
        queueMicrotask(() => {
          const opened = commitChatPaneDrop(routeThreadRef);
          if (opened) activate(opened);
        });
      }}
    >
      <PaneNode
        node={root}
        root={root}
        routeThreadKey={routeThreadKey}
        onActivate={activate}
        onClosed={follow}
      />
    </div>
  );
}

function findLeaf(node: ChatPaneNode, threadKey: string): ChatPaneLeaf | null {
  if (node.kind === "leaf") return scopedThreadKey(node.threadRef) === threadKey ? node : null;
  return findLeaf(node.first, threadKey) ?? findLeaf(node.second, threadKey);
}

interface PaneNodeProps {
  node: ChatPaneNode;
  root: ChatPaneNode;
  routeThreadKey: string;
  onActivate: (threadRef: ScopedThreadRef) => void;
  /** Receives the survivor's thread when the focused pane closed. */
  onClosed: (threadRef: ScopedThreadRef | null) => void;
}

function PaneNode({ node, root, routeThreadKey, onActivate, onClosed }: PaneNodeProps) {
  const setRatio = useChatPanesStore((state) => state.setRatio);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // A moving pane leaves the tree before it lands, so its old slot must not
  // count against the depth cap of the pane it is dropped on.
  const sourcePaneId = useChatPaneDragStore((state) => state.sourcePaneId);
  const dropZoneResolver = useMemo(() => {
    const tree = sourcePaneId === null ? root : (removePane(root, sourcePaneId) ?? root);
    return (paneId: ChatPaneId) => selectPaneDropZoneResolver(tree, paneId);
  }, [root, sourcePaneId]);
  if (node.kind === "leaf") {
    return (
      <PaneLeaf
        leaf={node}
        resolveZone={dropZoneResolver}
        focused={scopedThreadKey(node.threadRef) === routeThreadKey}
        onActivate={onActivate}
        onClosed={onClosed}
      />
    );
  }
  const horizontal = node.direction === "horizontal";
  const splitId = node.id;
  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", horizontal ? "flex-row" : "flex-col")}
      style={{ "--pane-ratio": node.ratio } as CSSProperties}
      data-chat-pane-split={node.direction}
    >
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: "var(--pane-ratio) 1 0px" }}>
        <PaneNode
          node={node.first}
          root={root}
          routeThreadKey={routeThreadKey}
          onActivate={onActivate}
          onClosed={onClosed}
        />
      </div>
      <ChatPaneResizeHandle
        direction={node.direction}
        containerRef={containerRef}
        onRatioChange={(ratio) =>
          containerRef.current?.style.setProperty("--pane-ratio", String(ratio))
        }
        onRatioCommit={(ratio) => setRatio(splitId, ratio)}
      />
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flex: "calc(1 - var(--pane-ratio)) 1 0px" }}
      >
        <PaneNode
          node={node.second}
          root={root}
          routeThreadKey={routeThreadKey}
          onActivate={onActivate}
          onClosed={onClosed}
        />
      </div>
    </div>
  );
}

const PaneLeaf = memo(function PaneLeaf({
  leaf,
  resolveZone: resolveZoneFor,
  focused,
  onActivate,
  onClosed,
}: {
  leaf: ChatPaneLeaf;
  resolveZone: (paneId: ChatPaneId) => ReturnType<typeof selectPaneDropZoneResolver>;
  focused: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
  onClosed: (threadRef: ScopedThreadRef | null) => void;
}) {
  const { threadRef } = leaf;
  const close = useCallback(
    () => onClosed(useChatPanesStore.getState().closePane(leaf.id)),
    [leaf.id, onClosed],
  );
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const resolveZone = useMemo(() => resolveZoneFor(leaf.id), [leaf.id, resolveZoneFor]);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });

  // A thread deleted elsewhere takes its pane with it.
  useEffect(() => {
    if (status === "deleted") close();
  }, [close, status]);

  const title = shell?.title ?? "Thread";
  const headerDrag = usePaneHeaderDrag(leaf, title);

  return (
    <ChatPaneDropOverlay paneId={leaf.id} resolveZone={resolveZone}>
      <section
        aria-label={title}
        data-chat-pane={leaf.id}
        data-chat-pane-focused={focused ? "true" : "false"}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          !focused &&
            "after:pointer-events-none after:absolute after:inset-0 after:z-30 after:bg-background/35 after:transition-opacity after:duration-150",
        )}
        onPointerDownCapture={(event) => {
          // The header starts a move, not a switch: activating here would
          // remount the pane under the pointer and drop the gesture.
          if (event.target instanceof Element && event.target.closest("[data-chat-pane-header]")) {
            return;
          }
          if (!focused && !isChatPaneDragActive()) onActivate(threadRef);
        }}
      >
        <div
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 px-2 text-xs",
            focused ? "text-foreground" : "text-muted-foreground",
          )}
          data-chat-pane-header
          onPointerDown={headerDrag}
        >
          <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="min-w-0 flex-1 cursor-grab truncate font-medium select-none active:cursor-grabbing">
            {title}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-micro"
                  aria-label={`Close pane for ${title}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={close}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close pane</TooltipPopup>
          </Tooltip>
        </div>
        {shell ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            threadSyncPhase={threadSyncPhase}
            paneMode={focused ? "focused" : "background"}
            reserveTitleBarControlInset={false}
          />
        ) : null}
      </section>
    </ChatPaneDropOverlay>
  );
});

/** Picks the pane header up after a short move; a plain click leaves it alone. */
function usePaneHeaderDrag(leaf: ChatPaneLeaf, title: string) {
  const activeFinish = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeFinish.current?.();
      if (useChatPaneDragStore.getState().sourcePaneId === leaf.id) {
        useChatPaneDragStore.getState().end();
      }
    },
    [leaf.id],
  );
  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary || activeFinish.current) return;
      const start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      let started = false;
      const finish = () => {
        activeFinish.current = null;
        document.removeEventListener("pointermove", onMove, { capture: true });
        document.removeEventListener("pointerup", onUp, { capture: true });
        document.removeEventListener("pointercancel", onCancel, { capture: true });
        document.removeEventListener("keydown", onKey, { capture: true });
        window.removeEventListener("blur", onCancel);
        if (started) {
          document.body.style.removeProperty("cursor");
          document.body.style.removeProperty("user-select");
        }
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== start.pointerId) return;
        if (!started) {
          if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_DISTANCE) return;
          started = true;
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
          chatPaneDragPointer.current = { x: move.clientX, y: move.clientY };
          useChatPaneDragStore.getState().start({
            threadRef: leaf.threadRef,
            title,
            sourcePaneId: leaf.id,
          });
        }
        move.preventDefault();
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== start.pointerId) return;
        // The layout root applies a release over a pane; a release anywhere
        // else ends the gesture here.
        finish();
        const drag = useChatPaneDragStore.getState();
        if (drag.target === null) drag.end();
      };
      const onCancel = () => {
        finish();
        useChatPaneDragStore.getState().end();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key === "Escape") onCancel();
      };
      activeFinish.current = finish;
      document.addEventListener("pointermove", onMove, { capture: true });
      document.addEventListener("pointerup", onUp, { capture: true });
      document.addEventListener("pointercancel", onCancel, { capture: true });
      document.addEventListener("keydown", onKey, { capture: true });
      window.addEventListener("blur", onCancel);
    },
    [leaf, title],
  );
}

/** Floating label that follows the pointer while a thread is carried over the panes. */
export function ChatPaneDragGhost() {
  const title = useChatPaneDragStore((state) => (state.threadRef ? state.title : null));
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (title === null) return;
    const node = ref.current;
    if (!node) return;
    const onMove = (event: PointerEvent) => {
      const x = Math.min(event.clientX + 14, window.innerWidth - node.offsetWidth - 8);
      const y = Math.min(event.clientY + 10, window.innerHeight - node.offsetHeight - 8);
      node.style.transform = `translate(${x}px, ${y}px)`;
    };
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    return () => document.removeEventListener("pointermove", onMove, { capture: true });
  }, [title]);
  if (title === null) return null;
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[60] max-w-64 truncate rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg will-change-transform"
      style={{ transform: "translate(-9999px, -9999px)" }}
    >
      {title}
    </div>
  );
}
