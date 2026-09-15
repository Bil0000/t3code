import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/usage")({
  validateSearch: (search: Record<string, unknown>): { tab?: "limits" } =>
    search.tab === "limits" ? { tab: "limits" } : {},
  component: UsagePage,
});
