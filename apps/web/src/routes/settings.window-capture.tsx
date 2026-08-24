import { createFileRoute } from "@tanstack/react-router";

import { WindowCaptureSettings } from "../components/settings/WindowCaptureSettings";

function SettingsWindowCaptureRoute() {
  return <WindowCaptureSettings />;
}

export const Route = createFileRoute("/settings/window-capture")({
  component: SettingsWindowCaptureRoute,
});
