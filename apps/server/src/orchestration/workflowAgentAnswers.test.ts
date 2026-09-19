import { describe, expect, it } from "vite-plus/test";

import { parseWorkflowAgentAnswers } from "./workflowAgentAnswers.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const assistant = (id: string, content: ReadonlyArray<unknown>) =>
  line({ type: "assistant", message: { role: "assistant", id, content } });

describe("parseWorkflowAgentAnswers", () => {
  it("returns one entry per assistant turn", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "text", text: "first" }]) +
          assistant("b", [{ type: "text", text: "second" }]),
      ),
    ).toEqual(["first", "second"]);
  });

  it("joins the lines of one split assistant message into a single turn", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "thinking", thinking: "weighing it up" }]) +
          assistant("a", [{ type: "text", text: "the answer" }]) +
          assistant("a", [{ type: "text", text: "and more" }]),
      ),
    ).toEqual(["the answer\n\nand more"]);
  });

  it("ignores harness bookkeeping and the member's own prompt", () => {
    expect(
      parseWorkflowAgentAnswers(
        line({ type: "attachment", attachment: { type: "skill_listing", content: "- adhd" } }) +
          line({ type: "user", message: { role: "user", content: "the prompt" } }) +
          line({
            type: "assistant",
            isMeta: true,
            message: { role: "assistant", id: "m", content: [{ type: "text", text: "injected" }] },
          }) +
          assistant("a", [{ type: "text", text: "real answer" }]),
      ),
    ).toEqual(["real answer"]);
  });

  it("skips a turn that produced no text", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
      ),
    ).toEqual([]);
  });

  it("survives a trailing line the byte cap cut in half", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "text", text: "complete" }]) + '{"type":"assistant","mess',
      ),
    ).toEqual(["complete"]);
  });
});
