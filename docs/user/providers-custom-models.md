# Custom models

Add a model in **Settings → Providers → Models**. Use the settings button beside the custom model
to declare only the controls that model supports. Set its supported values and default value. The
message composer then shows only those controls.

T3 Code keeps the saved model ID exact. A provider adapter can change request syntax only when its
native API requires it. Existing custom models with no capability metadata keep their old behavior.

## Supported controls

| Provider | Custom controls T3 Code can send                             |
| -------- | ------------------------------------------------------------ |
| Claude   | Reasoning effort, Claude fast mode, context window, thinking |
| Codex    | Reasoning effort, service tier                               |
| Cursor   | Reasoning, context window, fast mode, thinking               |
| OpenCode | Variant and agent                                            |
| Grok     | None; T3 Code's Grok adapter sends only model selection      |

T3 Code hides metadata with an unsupported control name or value type. This prevents a control from
appearing when its provider adapter cannot send it.

The capability editor renders every select or on/off descriptor offered by the provider. New control
IDs do not need model-specific UI code.

Cursor sends choices through ACP session configuration. A choice is applied only when the active
Cursor CLI reports a matching configuration option for the selected model.

OpenCode sends `variant` and `agent` through its SDK request. Its adapter has no model speed-tier or
context-window request option. The Grok session data T3 Code consumes reports models but no supported
model options, so Grok custom models do not show capability controls.

Claude `fastMode` is a Claude Code setting. It is not OpenAI priority service. Codex sends speed as
its native `serviceTier` value. Do not use one as a substitute for the other.

For Claude only, selecting a declared `1m` context value adds Claude Code's `[1m]` model selector at
launch. The saved and displayed custom model ID stays unchanged. T3 Code does not assume 1M support
for any model that did not declare it.
