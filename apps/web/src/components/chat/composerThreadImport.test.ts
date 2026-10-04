import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { importComposerThreadAttachment } from "./composerThreadImport";

function deferredFile() {
  let resolve!: (file: File) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<File>((resolveFile, rejectFile) => {
    resolve = resolveFile;
    reject = rejectFile;
  });
  return { promise, resolve, reject };
}

describe("importComposerThreadAttachment", () => {
  it.each(["file", "image"])(
    "reserves the final slot during an overlapping %s attachment",
    async (kind) => {
      const pendingImports = new Map<string, number>();
      const targetKey = "draft";
      const attached = Array.from(
        { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 },
        (_, index) => `existing-${index}`,
      );
      const countReservedAttachments = () => attached.length + (pendingImports.get(targetKey) ?? 0);
      const attach = async (file: File) => {
        if (countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) return false;
        attached.push(file.name);
        return true;
      };
      const transcript = deferredFile();
      const importing = importComposerThreadAttachment({
        targetKey,
        pendingImports,
        countReservedAttachments,
        load: () => transcript.promise,
        isActive: () => true,
        attach,
        onLimitReached: () => {
          throw new Error("The final slot should be available");
        },
      });

      expect(await attach(new File(["unrelated"], `unrelated.${kind}`))).toBe(false);
      transcript.resolve(new File(["transcript"], "thread.txt"));
      await importing;

      expect(attached.at(-1)).toBe("thread.txt");
      expect(attached).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
      expect(pendingImports.size).toBe(0);
    },
  );

  it("rejects a repeated drop until the reserved slot is released", async () => {
    const pendingImports = new Map<string, number>();
    const transcript = deferredFile();
    const load = vi.fn(() => transcript.promise);
    const onLimitReached = vi.fn();
    const attach = vi.fn(async (_file: File) => true);
    const input = {
      targetKey: "draft",
      pendingImports,
      countReservedAttachments: () =>
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 + (pendingImports.get("draft") ?? 0),
      load,
      isActive: () => true,
      attach,
      onLimitReached,
    };
    const first = importComposerThreadAttachment(input);
    await importComposerThreadAttachment(input);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onLimitReached).toHaveBeenCalledTimes(1);

    transcript.resolve(new File(["transcript"], "thread.txt"));
    await first;
    await importComposerThreadAttachment(input);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(pendingImports.size).toBe(0);
  });

  it("keeps the second drop's slot reserved when the first drop finishes", async () => {
    const pendingImports = new Map<string, number>();
    const first = deferredFile();
    const second = deferredFile();
    const attached: string[] = [];
    const countReservedAttachments = () =>
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2 + attached.length + (pendingImports.get("draft") ?? 0);
    const attach = async (file: File) => {
      if (countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) return false;
      attached.push(file.name);
      return true;
    };
    const input = {
      targetKey: "draft",
      pendingImports,
      countReservedAttachments,
      isActive: () => true,
      attach,
      onLimitReached: () => {
        throw new Error("Both slots should be available");
      },
    };
    const firstImport = importComposerThreadAttachment({ ...input, load: () => first.promise });
    const secondImport = importComposerThreadAttachment({ ...input, load: () => second.promise });
    first.resolve(new File(["first"], "first-thread.txt"));
    await firstImport;
    expect(await attach(new File(["unrelated"], "unrelated.txt"))).toBe(false);

    second.resolve(new File(["second"], "second-thread.txt"));
    await secondImport;
    expect(attached).toEqual(["first-thread.txt", "second-thread.txt"]);
    expect(pendingImports.size).toBe(0);
  });

  it.each(["failure", "inactive"])(
    "releases the original draft's slot after %s",
    async (outcome) => {
      const pendingImports = new Map<string, number>();
      const transcript = deferredFile();
      const attach = vi.fn(async (_file: File) => true);
      let activeTargetKey = "original-draft";
      const input = {
        targetKey: "original-draft",
        pendingImports,
        countReservedAttachments: () =>
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 + (pendingImports.get("original-draft") ?? 0),
        load: () => transcript.promise,
        isActive: () => activeTargetKey === "original-draft",
        attach,
        onLimitReached: () => {
          throw new Error("The slot should have been released");
        },
      };
      const importing = importComposerThreadAttachment(input);
      if (outcome === "inactive") activeTargetKey = "new-draft";
      expect(pendingImports.get("new-draft") ?? 0).toBe(0);
      if (outcome === "failure") {
        const failed = expect(importing).rejects.toThrow("Failed to load");
        transcript.reject(new Error("Failed to load"));
        await failed;
      } else {
        transcript.resolve(new File(["transcript"], "stale-thread.txt"));
        await importing;
      }
      expect(attach).not.toHaveBeenCalled();
      expect(pendingImports.size).toBe(0);

      await importComposerThreadAttachment({
        ...input,
        load: async () => new File(["transcript"], "retry-thread.txt"),
        isActive: () => true,
      });
      expect(attach.mock.calls[0]?.[0]?.name).toBe("retry-thread.txt");
      expect(pendingImports.size).toBe(0);
    },
  );
});
