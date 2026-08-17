import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const generateWorkItemTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:work-items:generate-task",
  tag: WS_METHODS.workItemsGenerateTask,
});
