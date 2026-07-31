import { type SessionPhase } from "../../types";

/**
 * Whether a turn that just settled should pull the next stashed prompt into
 * the composer and send it (Settings → General → "Stashed prompts").
 *
 * Edge-triggered on the turn ending rather than level-triggered on an idle
 * thread: prompts stashed while nothing is running — or sitting there when
 * the setting is switched on, or when the thread is opened — must stay put.
 * Otherwise merely looking at an idle thread would fire one off.
 */
export function shouldAutoSendStashedPrompt(input: {
  /** The `autoSendStashedPrompts` setting. */
  enabled: boolean;
  hasStashedPrompt: boolean;
  /** Whether the thread was mid-turn at the previous evaluation. */
  wasWorking: boolean;
  isWorking: boolean;
  /**
   * Only a turn that ran to completion ("ready") qualifies. An interrupted or
   * failed one settles as "disconnected", and carrying on from where the user
   * hit stop is the opposite of what they asked for.
   */
  phase: SessionPhase;
  /** The user has their own content in the composer; theirs wins. */
  hasComposerContent: boolean;
  /**
   * A plain send is unavailable — an approval, a plan question, or a follow-up
   * prompt owns the composer. What the user cannot send by hand right now, the
   * stash must not send for them.
   */
  sendBlocked: boolean;
}): boolean {
  if (!input.enabled || !input.hasStashedPrompt) return false;
  if (!input.wasWorking || input.isWorking) return false;
  if (input.phase !== "ready") return false;
  return !input.hasComposerContent && !input.sendBlocked;
}
