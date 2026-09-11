import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    for (const branch of ["review", "other", null]) {
      clearProjectFileQueryData(environmentId, "/repo", "convex.json", branch);
    }
    vi.unstubAllGlobals();
  });

  it("keeps a rejected branch's newer draft out of another checkout", () => {
    vi.stubGlobal("window", {});
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "old draft", "review");
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "newer old draft", "review");
    expect(
      resolveProjectFileQueryData(environmentId, "/repo", "convex.json", null, "other"),
    ).toBeNull();
    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json", null),
    ).toBeNull();

    setProjectFileQueryData(environmentId, "/repo", "convex.json", "new branch draft", "other");
    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/repo",
        "convex.json",
        "new branch draft",
        "review",
      ),
    ).toBe(false);
    clearProjectFileQueryData(environmentId, "/repo", "convex.json", "review");
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json", "other")?.contents,
    ).toBe("new branch draft");
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json", "review"),
    ).toBeNull();

    setProjectFileQueryData(environmentId, "/repo", "convex.json", "detached draft", null);
    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });
});
