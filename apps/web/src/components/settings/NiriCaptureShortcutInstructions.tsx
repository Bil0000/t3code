import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";

export function NiriCaptureShortcutInstructions({
  binding,
  disabled = false,
}: {
  binding: string | undefined;
  disabled?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Paste inside <code>binds &#123; … &#125;</code> in <code>~/.config/niri/config.kdl</code>.
      </p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3 text-xs">
        {binding}
      </pre>
      <Button
        variant="outline"
        size="sm"
        disabled={!binding || disabled}
        onClick={() => {
          if (binding) copyToClipboard(binding);
        }}
      >
        {isCopied ? "Copied" : "Copy binding"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Change Ctrl+Shift+2 if needed. Niri applies the binding when you save.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Using a custom config?</summary>
        <p className="mt-2">
          Edit your active config instead. It may be set by --config, NIRI_CONFIG, or
          XDG_CONFIG_HOME. Remove the binding to undo setup.
        </p>
      </details>
    </div>
  );
}
