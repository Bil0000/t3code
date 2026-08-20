import { stackedThreadToast, toastManager } from "../ui/toast";

export function reportCommitHashCopyFailure(error: Error): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not copy commit hash",
      description: error.message,
    }),
  );
}
