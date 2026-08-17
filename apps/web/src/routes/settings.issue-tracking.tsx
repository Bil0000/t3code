import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/issue-tracking")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/source-control", hash: "issue-tracking", replace: true });
  },
});
