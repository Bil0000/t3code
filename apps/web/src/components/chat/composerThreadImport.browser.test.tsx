import { EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  composerThreadImportBlockReason,
  importComposerThreadAttachment,
  useComposerThreadImportScope,
} from "./composerThreadImport";
import { THREAD_CONTEXT_DROP_EVENT, useThreadContextDrop } from "./threadContextDrag";

function deferredFile() {
  let resolve!: (file: File) => void;
  const promise = new Promise<File>((resolveFile) => {
    resolve = resolveFile;
  });
  return { promise, resolve };
}

describe.each(["mention", "drop"])("importComposerThreadAttachment from a thread %s", (source) => {
  it.each(["expand", "draft switch", "environment switch", "unmount"])(
    "keeps import ownership correct after %s while loading",
    async (change) => {
      const target = new EventTarget();
      const transcript = deferredFile();
      const pendingImports = new Map<string, number>();
      const attached: string[] = [];
      const expandedAtDrop: boolean[] = [];
      let importing!: Promise<void>;
      let importMention!: () => void;
      function Composer({
        environmentId,
        targetKey,
        expanded,
      }: {
        environmentId: EnvironmentId;
        targetKey: string;
        expanded: boolean;
      }) {
        const targetRef = useRef<EventTarget | null>(target);
        const scopeRef = useComposerThreadImportScope(environmentId, targetKey);
        const startImport = (isActive: () => boolean) => {
          expandedAtDrop.push(expanded);
          const scope = scopeRef.current;
          importing = importComposerThreadAttachment({
            targetKey,
            pendingImports,
            countReservedAttachments: () => pendingImports.get(targetKey) ?? 0,
            load: () => transcript.promise,
            isActive: () => scope.active && isActive(),
            attach: async (file) => {
              attached.push(file.name);
              return true;
            },
            onLimitReached: () => {
              throw new Error("The slot should be available");
            },
          });
        };
        useLayoutEffect(() => {
          importMention = () => startImport(() => true);
        });
        useThreadContextDrop(targetRef, environmentId, targetKey, (_refs, isActive) =>
          startImport(isActive),
        );
        return null;
      }

      const props = {
        environmentId: EnvironmentId.make("destination"),
        targetKey: "draft",
        expanded: false,
      };
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const root = createRoot(document.createElement("div"));
      try {
        act(() => root.render(<Composer {...props} />));
        const begin = () =>
          source === "mention"
            ? importMention()
            : target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [] }));
        act(begin);
        expect(pendingImports.get("draft")).toBe(1);
        if (change === "unmount") {
          act(() => root.unmount());
        } else {
          act(() =>
            root.render(
              <Composer
                {...props}
                expanded
                {...(change === "draft switch" ? { targetKey: "another-draft" } : {})}
                {...(change === "environment switch"
                  ? { environmentId: EnvironmentId.make("another-environment") }
                  : {})}
              />,
            ),
          );
          if (change !== "expand") {
            act(() => root.render(<Composer {...props} />));
          }
        }
        transcript.resolve(new File(["transcript"], "thread.txt"));
        await act(async () => importing);
        expect(attached).toEqual(change === "expand" ? ["thread.txt"] : []);
        expect(pendingImports.size).toBe(0);
        if (change === "expand") {
          act(begin);
          await act(async () => importing);
          expect(expandedAtDrop).toEqual([false, true]);
          expect(attached).toEqual(["thread.txt", "thread.txt"]);
        }
      } finally {
        if (change !== "unmount") act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("thread mention import preflight", () => {
  it.each([
    {
      fileStagingLimit: null,
      fileCapabilityBlockReason: null,
      reservedAttachmentCount: 0,
      expected: "This server does not support file attachments.",
    },
    {
      fileStagingLimit: 100,
      fileCapabilityBlockReason: "Waiting for the server before file attachments can send",
      reservedAttachmentCount: 0,
      expected: "Waiting for the server before file attachments can send",
    },
    {
      fileStagingLimit: 100,
      fileCapabilityBlockReason: null,
      reservedAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      expected: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    },
    {
      fileStagingLimit: 100,
      fileCapabilityBlockReason: null,
      reservedAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      expected: null,
    },
  ])("reports the import rejection reason: $expected", ({ expected, ...input }) => {
    expect(composerThreadImportBlockReason(input)).toBe(expected);
  });
});
