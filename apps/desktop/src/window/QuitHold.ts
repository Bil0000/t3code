// Chrome-style hold-to-quit. The quit accelerator is intercepted in
// before-input-event (which runs before the native menu accelerator), and the
// app only quits once the shortcut has been held for QUIT_HOLD_DURATION_MS.
// A quick tap just shows the renderer's "Hold to Quit" hint. Quitting from the
// application menu itself is untouched and quits immediately.
export const QUIT_HOLD_DURATION_MS = 1500;

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
  let holdTimer: NodeJS.Timeout | undefined;
  let holding = false;

  const release = () => {
    if (!holding) return;
    holding = false;
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
    options.notify("up");
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
    if (input.isAutoRepeat || holding) return;

    holding = true;
    options.notify("down");
    void options.isEnabled().then(
      (enabled) => {
        if (!enabled) {
          // Hold-to-quit disabled: a single press quits immediately.
          holding = false;
          options.quit();
          return;
        }
        if (!holding) return;
        holdTimer = setTimeout(() => {
          holdTimer = undefined;
          holding = false;
          options.quit();
        }, QUIT_HOLD_DURATION_MS);
      },
      // A failed settings read must never strand the quit request.
      () => {
        holding = false;
        options.quit();
      },
    );
  };
}
