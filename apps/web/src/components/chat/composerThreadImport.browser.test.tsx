import { EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";

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
      await using screen = await render(<Composer {...props} />);
      const begin = () =>
        source === "mention"
          ? importMention()
          : target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [] }));
      await act(begin);
      expect(pendingImports.get("draft")).toBe(1);
      if (change === "unmount") {
        await screen.unmount();
      } else {
        await screen.rerender(
          <Composer
            {...props}
            expanded
            {...(change === "draft switch" ? { targetKey: "another-draft" } : {})}
            {...(change === "environment switch"
              ? { environmentId: EnvironmentId.make("another-environment") }
              : {})}
          />,
        );
        if (change !== "expand") {
          await screen.rerender(<Composer {...props} />);
        }
      }
      transcript.resolve(new File(["transcript"], "thread.txt"));
      await act(() => importing);
      expect(attached).toEqual(change === "expand" ? ["thread.txt"] : []);
      expect(pendingImports.size).toBe(0);
      if (change === "expand") {
        await act(begin);
        await act(() => importing);
        expect(expandedAtDrop).toEqual([false, true]);
        expect(attached).toEqual(["thread.txt", "thread.txt"]);
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
