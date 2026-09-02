import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  effortColor,
  effortFraction,
  nextSelectOptionId,
  resolveEffortDescriptor,
  resolveFastMode,
} from "./composerModelPill";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const serviceTier: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "serviceTier",
  label: "Service Tier",
  type: "select",
  options: [
    { id: "default", label: "Standard", isDefault: true },
    { id: "priority", label: "Fast" },
  ],
  currentValue: "default",
};
const contextWindow: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "contextWindow",
  label: "Context Window",
  type: "select",
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M", isDefault: true },
  ],
};
const effort: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
};

describe("resolveFastMode", () => {
  it("toggles the fastMode boolean", () => {
    const descriptor: ProviderOptionDescriptor = {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
      currentValue: true,
    };
    expect(resolveFastMode(CLAUDE, [descriptor])).toEqual({
      descriptorId: "fastMode",
      enabled: true,
      toggledValue: false,
    });
  });

  it("maps the Codex Fast service tier onto fast mode", () => {
    expect(resolveFastMode(CODEX, [serviceTier])).toEqual({
      descriptorId: "serviceTier",
      enabled: false,
      toggledValue: "priority",
    });
    expect(resolveFastMode(CODEX, [{ ...serviceTier, currentValue: "priority" }])).toEqual({
      descriptorId: "serviceTier",
      enabled: true,
      toggledValue: "default",
    });
  });

  it("ignores the service tier for other providers and unrelated tiers", () => {
    expect(resolveFastMode(CLAUDE, [serviceTier])).toBeNull();
    expect(resolveFastMode(CODEX, [{ ...serviceTier, currentValue: "flex" }])).toBeNull();
  });
});

describe("resolveEffortDescriptor", () => {
  it("skips structural selects like context window and agent", () => {
    expect(resolveEffortDescriptor([contextWindow, serviceTier, effort])?.id).toBe("effort");
    expect(resolveEffortDescriptor([contextWindow])).toBeNull();
  });
});

describe("effort scale", () => {
  it("spreads levels from 0 to 1 and clamps single-option scales", () => {
    expect(effortFraction(0, 3)).toBe(0);
    expect(effortFraction(1, 3)).toBe(0.5);
    expect(effortFraction(2, 3)).toBe(1);
    expect(effortFraction(0, 1)).toBe(1);
  });

  it("blends towards primary then violet", () => {
    expect(effortColor(0)).toContain("var(--primary) 0%");
    expect(effortColor(0.5)).toContain("oklch(0.62 0.25 300) 0%");
    expect(effortColor(1)).toContain("oklch(0.62 0.25 300) 100%");
  });
});

describe("nextSelectOptionId", () => {
  it("cycles from the current or default option and wraps", () => {
    expect(nextSelectOptionId(contextWindow)).toBe("200k");
    expect(nextSelectOptionId({ ...contextWindow, currentValue: "200k" })).toBe("1m");
  });
});
