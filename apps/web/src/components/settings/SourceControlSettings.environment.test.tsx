import type { ReactElement } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentPresentation } from "../../state/environments";
import { visitElements } from "../../test/reactElementTree";

const environmentState = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  primary: null as EnvironmentPresentation | null,
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: environmentState.environments }),
  usePrimaryEnvironment: () => environmentState.primary,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { sourceControlProviders: [], versionControlSystems: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: vi.fn() },
}));

import { IssueTrackingSettingsSection } from "./IssueTrackingSettings";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

describe("SourceControlSettingsPanel environments", () => {
  it("hides primary-only issue tracking for a fallback environment", () => {
    environmentState.primary = null;
    environmentState.environments = [
      {
        environmentId: EnvironmentId.make("fallback"),
        connection: { phase: "connected" },
      } as EnvironmentPresentation,
    ];

    const panel = SourceControlSettingsPanel() as ReactElement<Record<string, unknown>>;

    expect(visitElements(panel, (element) => element.type === IssueTrackingSettingsSection)).toBe(
      null,
    );
  });
});
