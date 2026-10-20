import {
  BackgroundActivityProfile,
  EnvironmentReadTarget,
  EnvironmentBrowseInput,
  EnvironmentBrowseResult,
  EnvironmentReadError,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as EnvironmentReadService from "../../EnvironmentReadService.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and selected environment preferences. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const EnvironmentListTool = Tool.make("t3_environment_list", {
  description:
    "List this environment and explicitly shared read sources from a connected client. Sharing is off by default. A remote target may be offline, denied, or unsupported. Results include the target environmentId.",
  success: Schema.Struct({ environments: Schema.Array(EnvironmentReadTarget) }),
  failure: Schema.Union([EnvironmentReadError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    EnvironmentReadService.EnvironmentReadService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentBrowseTool = Tool.make("t3_environment_browse", {
  description:
    "Read projects and threads from an explicitly shared environment. Omit environmentId for local reads. request.operation is project.list, project.read, thread.list, thread.search, or thread.read. Use project.list then thread.search to find a topic; paginate with nextCursor. Archive reads require archived='include' or 'only'. Thread history pages use nextPosition/afterPosition and itemId/textOffset. This tool never acknowledges child results or writes remote state. Target environmentId is returned; all IDs belong to that environment.",
  parameters: EnvironmentBrowseInput,
  success: EnvironmentBrowseResult,
  failure: Schema.Union([EnvironmentReadError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    EnvironmentReadService.EnvironmentReadService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentListTool,
  EnvironmentBrowseTool,
);
