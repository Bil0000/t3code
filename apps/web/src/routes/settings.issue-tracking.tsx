import { createFileRoute } from "@tanstack/react-router";

import { IssueTrackingSettingsPanel } from "../components/settings/IssueTrackingSettings";

export const Route = createFileRoute("/settings/issue-tracking")({
  component: IssueTrackingSettingsPanel,
});
