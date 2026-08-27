import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SideQuestionMinimized, SideQuestionPanel } from "./SideQuestionPanel";

const turns = [
  {
    question: "Why SQLite?",
    id: 1,
    answer: "It keeps local state durable.",
    status: "success" as const,
  },
];

describe("SideQuestionPanel", () => {
  it("renders the side conversation and follow-up controls", () => {
    const markup = renderToStaticMarkup(
      <SideQuestionPanel
        cwd="/tmp/project"
        turns={turns}
        onMinimize={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain("Why SQLite?");
    expect(markup).toContain("It keeps local state durable.");
    expect(markup).toContain('data-user-message-bubble="true"');
    expect(markup).toContain("max-w-[80%] rounded-2xl bg-message p-3");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("wrap-break-word");
    expect(markup).toContain("chat-composer-glass-shell");
    expect(markup).toContain('data-chat-composer-main-surface="true"');
    expect(markup).toContain('aria-label="Ask a follow-up side question"');
    expect(markup).toContain("Ask another side question…");
    expect(markup).toContain('aria-label="Ask follow-up"');
    expect(markup).toContain('aria-label="Minimize side question"');
  });

  it("keeps the follow-up field editable while an answer is pending", () => {
    const markup = renderToStaticMarkup(
      <SideQuestionPanel
        cwd="/tmp/project"
        turns={[{ ...turns[0]!, status: "loading" }]}
        onMinimize={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup.match(/<textarea[^>]*>/)?.[0]).not.toContain("disabled");
  });

  it("renders a compact composer attachment that can restore or dismiss the panel", () => {
    const markup = renderToStaticMarkup(
      <SideQuestionMinimized
        question="Why SQLite?"
        status="success"
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
      />,
    );

    expect(markup).toContain("chat-composer-top-drawer");
    expect(markup).toContain("Side question");
    expect(markup).toContain("Why SQLite?");
    expect(markup).toContain('aria-label="Open side question"');
    expect(markup).toContain('aria-label="Dismiss side question"');
  });
});
