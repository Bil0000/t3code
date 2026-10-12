import { IssueUnavailableError } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { IssuesUnavailableState } from "./IssuesUnavailableState";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("offers no retry for a tracker the host removed, and keeps it for other failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const retired = new IssueUnavailableError({ reason: "tracker-retired" }).message;
  await act(() => {
    renderer = create(<IssuesUnavailableState error={retired} onRetry={vi.fn()} />);
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  await act(() => renderer.update(<IssuesUnavailableState error="timeout" onRetry={vi.fn()} />));
  expect(renderer.root.findAllByType("button")).toHaveLength(1);
});
