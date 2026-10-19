import { createRoot } from "react-dom/client";

export function createIssueTestRoot() {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}
