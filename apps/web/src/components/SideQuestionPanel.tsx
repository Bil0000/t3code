import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircleQuestion, Minimize2Icon, SendIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

export type SideQuestionTurn = {
  readonly question: string;
  readonly id: number;
  readonly answer: string;
  readonly status: "loading" | "success" | "error";
};

export function SideQuestionPanel(props: {
  readonly cwd: string | undefined;
  readonly threadRef?: ScopedThreadRef;
  readonly turns: ReadonlyArray<SideQuestionTurn>;
  readonly onMinimize: () => void;
  readonly onSubmit: (question: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const pending = props.turns.at(-1)?.status === "loading";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || pending) return;
    props.onSubmit(question);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-border/60 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="font-medium text-sm">Side question</div>
          <div className="text-muted-foreground text-xs">
            Ask without interrupting the main agent.
          </div>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Minimize side question"
          onClick={props.onMinimize}
        >
          <Minimize2Icon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div className="space-y-5 p-4" aria-live="polite">
          {props.turns.map((turn) => (
            <div key={turn.id} className="space-y-2.5">
              <div className="ml-8 rounded-xl bg-accent px-3 py-2 text-sm text-foreground">
                {turn.question}
              </div>
              {turn.status === "loading" ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Spinner aria-hidden="true" className="size-4" />
                  Thinking…
                </div>
              ) : turn.status === "error" ? (
                <div className="text-destructive text-sm">{turn.answer}</div>
              ) : (
                <ChatMarkdown
                  text={turn.answer}
                  cwd={props.cwd}
                  {...(props.threadRef ? { threadRef: props.threadRef } : {})}
                  className="text-sm"
                />
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      <form className="shrink-0 border-border/60 border-t p-3" onSubmit={submit}>
        <Textarea
          size="sm"
          value={draft}
          disabled={pending}
          aria-label="Ask a follow-up side question"
          placeholder="Ask a follow-up…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" disabled={pending || draft.trim().length === 0}>
            <SendIcon className="size-3.5" />
            Ask follow-up
          </Button>
        </div>
      </form>
    </div>
  );
}

export function SideQuestionMinimized(props: {
  readonly question: string;
  readonly status: SideQuestionTurn["status"];
  readonly onDismiss: () => void;
  readonly onRestore: () => void;
}) {
  return (
    <div
      className="chat-composer-top-drawer"
      data-chat-composer-side-question="true"
      data-variant={props.status === "error" ? "error" : "info"}
    >
      <div className="flex items-center gap-1 px-3 py-1.5 sm:px-4">
        <button
          type="button"
          aria-label="Open side question"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={props.onRestore}
          onPointerDown={(event) => event.preventDefault()}
        >
          <MessageCircleQuestion aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-foreground">Side question</span>
          <span className="min-w-0 flex-1 truncate">{props.question}</span>
          {props.status === "loading" ? (
            <Spinner aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <span className="shrink-0">
              {props.status === "error" ? "Needs attention" : "Answered"}
            </span>
          )}
        </button>
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Dismiss side question"
          onClick={props.onDismiss}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      </div>
    </div>
  );
}
