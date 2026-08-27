import type { ModelSelection, ScopedThreadRef, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { MessageCircleQuestion, Minimize2Icon, XIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { composerSubmissionIntentForEnter } from "../composer-logic";
import { useMediaQuery } from "../hooks/useMediaQuery";
import ChatMarkdown from "./ChatMarkdown";
import { getAppModelOptionsForInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { ComposerStopButton } from "./chat/ComposerPrimaryActions";
import { getComposerProviderState } from "./chat/composerProviderState";
import { MessageCopyButton } from "./chat/MessageCopyButton";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { TraitsPicker } from "./chat/TraitsPicker";
import { UserMessageActions, UserMessageBubble } from "./chat/UserMessageBubble";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

export type SideQuestionTurn = {
  readonly question: string;
  readonly id: string;
  readonly answer: string;
  readonly status: "loading" | "success" | "error" | "stopped";
};

export function SideQuestionPanel(props: {
  readonly cwd: string | undefined;
  readonly threadRef?: ScopedThreadRef;
  readonly turns: ReadonlyArray<SideQuestionTurn>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly modelSelection: ModelSelection;
  readonly onMinimize: () => void;
  readonly onModelSelectionChange: (selection: ModelSelection) => void;
  readonly onStop: () => void;
  readonly onSubmit: (question: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const isMobileViewport = useMediaQuery("max-sm");
  const pending = props.turns.at(-1)?.status === "loading";
  const providerEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(props.providers),
          props.settings,
        ),
      ),
    [props.providers, props.settings],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        providerEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(props.settings, entry),
        ]),
      ),
    [providerEntries, props.settings],
  );
  const activeEntry =
    providerEntries.find((entry) => entry.instanceId === props.modelSelection.instanceId) ?? null;
  const selectModel = (instanceId: ModelSelection["instanceId"], model: string) => {
    const entry = providerEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) return;
    const providerState = getComposerProviderState({
      provider: entry.driverKind,
      model,
      models: entry.models,
      modelOptions:
        instanceId === props.modelSelection.instanceId ? props.modelSelection.options : undefined,
      planModeEnabled: props.settings.planModeEnabled,
    });
    props.onModelSelectionChange(
      createModelSelection(instanceId, model, providerState.modelOptionsForDispatch),
    );
  };
  const submitDraft = () => {
    const question = draft.trim();
    if (!question || pending) return;
    props.onSubmit(question);
    setDraft("");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitDraft();
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
              <div className="group flex flex-col items-end gap-1">
                <UserMessageBubble className="whitespace-pre-wrap wrap-break-word text-sm">
                  {turn.question}
                </UserMessageBubble>
                <UserMessageActions>
                  <MessageCopyButton text={turn.question} variant="ghost" />
                </UserMessageActions>
              </div>
              {turn.status === "loading" ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Spinner aria-hidden="true" className="size-4" />
                  Thinking…
                </div>
              ) : turn.status === "error" ? (
                <div className="text-destructive text-sm">{turn.answer}</div>
              ) : turn.status === "stopped" ? (
                <div className="text-muted-foreground text-sm">Stopped</div>
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

      <div className="shrink-0 border-border/60 border-t p-3">
        <form className="chat-composer-glass-shell relative" onSubmit={submit}>
          <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
            <div
              data-chat-composer-main-surface="true"
              className="group relative z-10 rounded-[22px] p-px"
            >
              <div data-chat-composer-surface="true" className="rounded-[20px]">
                <div className="px-3 pt-3 sm:px-4 sm:pt-3.5">
                  <Textarea
                    unstyled
                    size="sm"
                    className="block text-sm [&_[data-slot=textarea]]:max-h-50 [&_[data-slot=textarea]]:overflow-y-auto"
                    value={draft}
                    style={{ resize: "none" }}
                    aria-label="Ask a follow-up side question"
                    placeholder="Ask another side question…"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.key !== "Enter") return;
                      const submissionIntent = composerSubmissionIntentForEnter({
                        isMobileViewport,
                        shiftKey: event.shiftKey,
                        modifierKey: event.metaKey || event.ctrlKey,
                        isDraftThread: false,
                      });
                      if (!submissionIntent) return;
                      event.preventDefault();
                      submitDraft();
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                  <div className="flex min-w-0 items-center gap-1">
                    {activeEntry ? (
                      <>
                        <ProviderModelPicker
                          compact
                          activeInstanceId={props.modelSelection.instanceId}
                          model={props.modelSelection.model}
                          lockedProvider={null}
                          instanceEntries={providerEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          terminalOpen={false}
                          triggerAriaLabel="Side question model"
                          onInstanceModelChange={selectModel}
                        />
                        <TraitsPicker
                          provider={activeEntry.driverKind}
                          instanceId={activeEntry.instanceId}
                          models={activeEntry.models}
                          model={props.modelSelection.model}
                          prompt=""
                          onPromptChange={() => undefined}
                          modelOptions={props.modelSelection.options}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={props.settings.planModeEnabled}
                          onModelOptionsChange={(options) =>
                            props.onModelSelectionChange(
                              createModelSelection(
                                props.modelSelection.instanceId,
                                props.modelSelection.model,
                                options,
                              ),
                            )
                          }
                        />
                      </>
                    ) : null}
                  </div>
                  {pending ? (
                    <ComposerStopButton onClick={props.onStop} />
                  ) : (
                    <Button
                      type="submit"
                      size="icon"
                      className="rounded-full border-transparent bg-message-action text-message-action-foreground transition-transform hover:scale-105 hover:bg-message-action-hover"
                      disabled={draft.trim().length === 0}
                      aria-label="Ask follow-up"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
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
              {props.status === "error"
                ? "Needs attention"
                : props.status === "stopped"
                  ? "Stopped"
                  : "Answered"}
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
