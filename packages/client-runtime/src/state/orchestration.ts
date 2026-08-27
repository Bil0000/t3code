import {
  ORCHESTRATION_SIDE_QUESTION_MAX_PREVIOUS_TURNS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationCancelSideQuestionResult,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function parseSideQuestion(value: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(value);
  return match ? (match[1]?.trim() ?? "") : null;
}

export function sideQuestionPreviousTurns(
  turns: ReadonlyArray<{ question: string; answer: string; status: string }>,
) {
  return turns
    .filter((turn) => turn.status === "success")
    .slice(-ORCHESTRATION_SIDE_QUESTION_MAX_PREVIOUS_TURNS)
    .map((turn) => ({ question: turn.question, answer: turn.answer }));
}

export function sideQuestionCancellationSucceeded(
  result: AtomCommandResult<OrchestrationCancelSideQuestionResult, unknown>,
): boolean {
  return result._tag === "Success" && result.value.cancelled;
}

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    askSideQuestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:ask-side-question",
      tag: ORCHESTRATION_WS_METHODS.askSideQuestion,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    cancelSideQuestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:cancel-side-question",
      tag: ORCHESTRATION_WS_METHODS.cancelSideQuestion,
    }),
  };
}
