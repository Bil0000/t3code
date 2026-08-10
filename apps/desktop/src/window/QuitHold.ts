// @effect-diagnostics globalDate:off globalTimers:off -- Synchronous before-input-event handler; key events must be timed and the watchdog scheduled outside any Effect runtime.

// Chrome-style hold-to-quit. The quit accelerator is intercepted in
// before-input-event (which runs before the native menu accelerator), and the
// app only quits once the shortcut has been held for QUIT_HOLD_DURATION_MS.
// A quick tap just shows the renderer's "Hold to Quit" hint. Quitting from the
// application menu itself is untouched and quits immediately.
export const QUIT_HOLD_DURATION_MS = 1500;
// "Still held" is proven by auto-repeat keydowns, not by the absence of a
// release: macOS suppresses a letter's keyUp while the command key is down, so
// a tap's release can go completely unseen and a release-based timer would
// quit anyway. The press is treated as released once no key event has arrived
// for QUIT_HOLD_RELEASE_GRACE_MS past the hold duration. Keyboards with
// auto-repeat disabled cannot hold-to-quit and fall back to the menu's Quit.
export const QUIT_HOLD_RELEASE_GRACE_MS = 600;

export type QuitHoldState = "down" | "up";

export interface QuitHoldKeyInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

export interface QuitHoldOptions {
  readonly platform: NodeJS.Platform;
  readonly isEnabled: () => Promise<boolean>;
  readonly notify: (state: QuitHoldState) => void;
  readonly quit: () => void;
}

export function makeQuitHoldHandler(
  options: QuitHoldOptions,
): (event: { preventDefault: () => void }, input: QuitHoldKeyInput) => void {
  const modifierKey = options.platform === "darwin" ? "meta" : "control";
  let watchdog: NodeJS.Timeout | undefined;
  let holding = false;
  // Set once isEnabled resolves true; auto-repeats may only quit when armed.
  let armed = false;
  let heldSince = 0;
  // Incremented on every new press and every release/quit so a pending
  // isEnabled() resolution from a superseded press cannot arm (or quit for)
  // the current one.
  let generation = 0;

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  const release = () => {
    if (!holding) return;
    generation += 1;
    holding = false;
    armed = false;
    clearWatchdog();
    options.notify("up");
  };

  // Dismisses the overlay first: if the quit is cancelled downstream the
  // renderer must not be left with a stuck "Hold to Quit" hint.
  const quitNow = () => {
    release();
    options.quit();
  };

  return (event, input) => {
    const key = input.key.toLowerCase();
    if (input.type === "keyUp") {
      if (key === "q" || key === modifierKey) release();
      return;
    }
    if (input.type !== "keyDown") return;

    const modifierDown = options.platform === "darwin" ? input.meta : input.control;
    if (!modifierDown || input.alt || input.shift || key !== "q") return;

    event.preventDefault();

    if (input.isAutoRepeat) {
      if (armed && Date.now() - heldSince >= QUIT_HOLD_DURATION_MS) {
        quitNow();
      }
      return;
    }
    if (holding) return;

    generation += 1;
    const pressGeneration = generation;
    holding = true;
    heldSince = Date.now();
    options.notify("down");
    void options.isEnabled().then(
      (enabled) => {
        if (generation !== pressGeneration) return;
        if (!enabled) {
          // Hold-to-quit disabled: a single press quits immediately.
          quitNow();
          return;
        }
        armed = true;
        // No auto-repeat by then means the key was released (possibly with a
        // suppressed keyUp) or repeat is disabled; either way, don't quit.
        watchdog = setTimeout(() => {
          watchdog = undefined;
          release();
        }, QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
      },
      // A failed settings read must never strand the quit request.
      () => {
        if (generation !== pressGeneration) return;
        quitNow();
      },
    );
  };
}
