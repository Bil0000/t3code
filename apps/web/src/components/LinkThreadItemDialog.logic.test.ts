import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: vi.fn() },
}));

import { linkDialogStatus, linkThreadItemKindOf } from "./LinkThreadItemDialog";

describe("linkThreadItemKindOf", () => {
  it("reads the kind from a URL's path and leaves bare numbers to the toggle", () => {
    expect(linkThreadItemKindOf("https://github.com/acme/web/pull/7")).toBe("pull-request");
    expect(linkThreadItemKindOf("https://github.com/acme/web/issues/7")).toBe("issue");
    expect(linkThreadItemKindOf("https://gitlab.com/g/sub/repo/-/merge_requests/3")).toBe(
      "pull-request",
    );
    expect(linkThreadItemKindOf("https://gitlab.com/g/sub/repo/-/issues/3")).toBe("issue");
    expect(linkThreadItemKindOf("#42")).toBeNull();
  });
});

const base = {
  noun: "issue",
  kindSupported: true,
  dirty: true,
  reference: "#42",
  resolved: { ref: {} },
  alreadyLinked: false,
} as const;

describe("linkDialogStatus", () => {
  it("links a resolved reference", () => {
    expect(linkDialogStatus(base)).toEqual({ canSubmit: true, message: null });
  });

  it("refuses an item the thread already has", () => {
    expect(linkDialogStatus({ ...base, alreadyLinked: true })).toEqual({
      canSubmit: false,
      message: "This issue is already linked.",
    });
  });

  it("explains input that does not resolve, once the user has typed", () => {
    expect(linkDialogStatus({ ...base, resolved: null, reference: "nope" }).message).toBe(
      "Use an issue URL, owner/repo#42, or #42.",
    );
    expect(linkDialogStatus({ ...base, resolved: null, reference: " " }).message).toBe(
      "Paste an issue URL or enter #42.",
    );
    expect(linkDialogStatus({ ...base, resolved: { error: "No project." } }).message).toBe(
      "No project.",
    );
    expect(linkDialogStatus({ ...base, resolved: null, dirty: false })).toEqual({
      canSubmit: false,
      message: null,
    });
  });

  it("refuses a kind the environment cannot link", () => {
    expect(linkDialogStatus({ ...base, kindSupported: false })).toEqual({
      canSubmit: false,
      message: "This environment cannot link issues.",
    });
  });
});
