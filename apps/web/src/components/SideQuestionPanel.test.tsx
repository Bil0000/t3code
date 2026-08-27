import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { SideQuestionMinimized, SideQuestionPanel } from "./SideQuestionPanel";

const turns = [
  {
    question: "Why SQLite?",
    id: "question-1",
    answer: "It keeps local state durable.",
    status: "success" as const,
  },
];

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5",
      name: "GPT-5",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const panelProps = {
  providers: [provider],
  settings: DEFAULT_UNIFIED_SETTINGS,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  onMinimize: vi.fn(),
  onModelSelectionChange: vi.fn(),
  onStop: vi.fn(),
  onSubmit: vi.fn(),
  runContext: {
    environmentId: EnvironmentId.make("remote"),
    availableEnvironments: [
      {
        environmentId: EnvironmentId.make("remote"),
        projectId: ProjectId.make("project-1"),
        label: "calendaty-staging",
        isPrimary: false,
      },
    ],
    showEnvironmentIndicator: true,
    showGitControls: true,
    activeWorktreePath: "/tmp/project",
    branch: "feat/btw-side-questions",
  },
};

describe("SideQuestionPanel", () => {
  it("renders the side conversation and follow-up controls", () => {
    const markup = renderToStaticMarkup(
      <SideQuestionPanel {...panelProps} cwd="/tmp/project" turns={turns} />,
    );

    expect(markup).toContain("Why SQLite?");
    expect(markup).toContain("It keeps local state durable.");
    expect(markup).toContain('data-user-message-bubble="true"');
    expect(markup).toContain("max-w-[80%] rounded-2xl bg-message p-3");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("wrap-break-word");
    expect(markup).toContain("chat-composer-glass-shell");
    expect(markup).toContain('data-side-question-composer-shell="true"');
    expect(markup.indexOf('data-side-question-context="true"')).toBeLessThan(
      markup.indexOf("</form>"),
    );
    expect(markup).toContain('data-chat-composer-main-surface="true"');
    expect(markup).toContain('aria-label="Ask a follow-up side question"');
    expect(markup).toContain('style="resize:none"');
    expect(markup).toContain("Ask another side question…");
    expect(markup).toContain('aria-label="Ask follow-up"');
    expect(markup).toContain('class="size-3.5"');
    expect(markup).toContain('aria-label="Side question model"');
    expect(markup).toContain("High");
    expect(markup).toContain('data-user-message-actions="true"');
    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('aria-label="Minimize side question"');
    expect(markup).toContain('data-side-question-context="true"');
    expect(markup).toContain("calendaty-staging");
    expect(markup).toContain("Worktree");
    expect(markup).toContain("feat/btw-side-questions");
  });

  it("keeps the follow-up field editable while an answer is pending", () => {
    const markup = renderToStaticMarkup(
      <SideQuestionPanel
        {...panelProps}
        cwd="/tmp/project"
        turns={[{ ...turns[0]!, status: "loading" }]}
      />,
    );

    expect(markup.match(/<textarea[^>]*>/)?.[0]).not.toContain("disabled");
    expect(markup).toContain('aria-label="Stop side question"');
    expect(markup).toContain("size-9 sm:size-8");
  });

  it("keeps model, effort, and Stop controls when the saved provider is unavailable", () => {
    const markup = renderToStaticMarkup(
      <SideQuestionPanel
        {...panelProps}
        cwd="/tmp/project"
        modelSelection={{
          instanceId: ProviderInstanceId.make("removed-provider"),
          model: "removed-model",
        }}
        turns={[{ ...turns[0]!, status: "loading" }]}
      />,
    );

    expect(markup).toContain('aria-label="Side question model"');
    expect(markup).toContain("Medium");
    expect(markup).toContain('aria-label="Stop side question"');
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
