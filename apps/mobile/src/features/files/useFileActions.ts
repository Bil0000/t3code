import { useEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";

export function useFileActions(name: string) {
  const [busy, setBusy] = useState<"save" | "attach" | null>(null);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => () => actionController.current?.abort(), []);
  const run = (action: "save" | "attach", task: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    const controller = new AbortController();
    actionController.current = controller;
    void task(controller.signal).then(
      () => {
        if (controller.signal.aborted) return;
        setBusy(null);
        if (action === "attach")
          Dialog.alert("Added to chat", `${name} is attached to your message.`);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setBusy(null);
        Dialog.alert(
          action === "save" ? "Could not save file" : "Could not add file to chat",
          cause instanceof Error ? cause.message : "Please try again.",
        );
      },
    );
  };
  return { busy, run };
}
