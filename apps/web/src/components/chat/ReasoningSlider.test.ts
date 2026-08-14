import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  getReasoningLevelColor,
  getReasoningRampIndex,
  isReasoningDescriptor,
  ReasoningSlider,
} from "./ReasoningSlider";

function selectDescriptor(
  id: string,
  label: string,
  optionIds: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id,
    label,
    type: "select",
    options: optionIds.map((optionId) => ({ id: optionId, label: optionId })),
  };
}

describe("isReasoningDescriptor", () => {
  it("matches the reasoning descriptor id of every harness", () => {
    for (const id of ["effort", "reasoningEffort", "reasoning"]) {
      expect(isReasoningDescriptor(selectDescriptor(id, "Reasoning", ["low", "high"]))).toBe(true);
    }
  });

  it("matches harness-provided labels when the id is unknown", () => {
    expect(isReasoningDescriptor(selectDescriptor("mystery", "Thinking Level", ["a", "b"]))).toBe(
      true,
    );
  });

  it("leaves other selects as menu lists", () => {
    expect(isReasoningDescriptor(selectDescriptor("serviceTier", "Service Tier", ["a", "b"]))).toBe(
      false,
    );
    expect(isReasoningDescriptor(selectDescriptor("agent", "Agent", ["build", "plan"]))).toBe(
      false,
    );
  });

  it("needs at least two stops to be a slider", () => {
    expect(isReasoningDescriptor(selectDescriptor("effort", "Reasoning", ["high"]))).toBe(false);
  });
});

describe("getReasoningRampIndex", () => {
  it("keeps known levels on the same colour across harnesses", () => {
    const claude = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"];
    const codex = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const claudeMax = getReasoningRampIndex("max", claude.indexOf("max"), claude.length);
    const codexMax = getReasoningRampIndex("max", codex.indexOf("max"), codex.length);
    expect(claudeMax).toBe(codexMax);
  });

  it("ramps unknown levels by position", () => {
    expect(getReasoningRampIndex("turbo", 0, 3)).toBe(0);
    expect(getReasoningRampIndex("turbo", 2, 3)).toBe(7);
    expect(getReasoningRampIndex("turbo", 0, 1)).toBe(0);
  });

  it("stays inside the declared ramp", () => {
    for (let index = 0; index < 12; index += 1) {
      const ramp = getReasoningRampIndex(`level-${index}`, index, 12);
      expect(ramp).toBeGreaterThanOrEqual(0);
      expect(ramp).toBeLessThanOrEqual(7);
    }
  });

  it("rises with effort", () => {
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const ramps = levels.map((level, index) => getReasoningRampIndex(level, index, levels.length));
    for (let index = 1; index < ramps.length; index += 1) {
      expect(ramps[index]).toBeGreaterThan(ramps[index - 1] as number);
    }
  });
});

describe("getReasoningLevelColor", () => {
  it("resolves to a declared ramp token", () => {
    expect(getReasoningLevelColor("low", 0, 5)).toBe("var(--reasoning-2)");
    expect(getReasoningLevelColor("ultrathink", 6, 7)).toBe("var(--reasoning-8)");
  });
});

describe("ReasoningSlider", () => {
  const CLAUDE_EFFORT = selectDescriptor("effort", "Reasoning", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  function render(value: string, disabled = false) {
    return renderToStaticMarkup(
      createElement(ReasoningSlider, {
        descriptor: CLAUDE_EFFORT,
        value,
        disabled,
        onValueChange: () => {},
      }),
    );
  }

  it("drives a native range input over the option list", () => {
    const markup = render("high");
    expect(markup).toContain('type="range"');
    expect(markup).toContain('max="4"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain('aria-valuetext="high"');
  });

  it("fills the capsule in the level colour and parks the thumb at the level offset", () => {
    expect(render("low")).toContain("left:calc(1rem + (100% - 1rem * 2) * 0)");
    const max = render("max");
    expect(max).toContain("left:calc(1rem + (100% - 1rem * 2) * 1)");
    expect(max).toContain("background-color:var(--reasoning-6)");
  });

  it("falls back to the first level when the value is unknown", () => {
    expect(render("nonsense")).toContain('value="0"');
  });

  it("disables the input when the prompt owns the effort", () => {
    expect(render("high", true)).toContain("disabled");
  });
});
