"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PlusIcon,
  Settings2Icon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type SelectProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getDeclaredCustomModelCapabilities,
  normalizeCustomModelSlug,
} from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged — only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
};

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
export function getCustomModelCapabilityTemplates(
  models: ReadonlyArray<ServerProviderModel>,
  configured: ModelCapabilities | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  const templates = new Map<string, ProviderOptionDescriptor>();
  const descriptors = [
    ...models.flatMap((model) => model.capabilities?.optionDescriptors ?? []),
    ...(configured?.optionDescriptors ?? []),
  ];

  for (const descriptor of descriptors) {
    const current = templates.get(descriptor.id);
    if (!current) {
      templates.set(descriptor.id, descriptor);
      continue;
    }
    if (current.type !== "select" || descriptor.type !== "select") continue;

    const optionIds = new Set(current.options.map((option) => option.id));
    const promptInjectedValues = [
      ...new Set([
        ...(current.promptInjectedValues ?? []),
        ...(descriptor.promptInjectedValues ?? []),
      ]),
    ];
    templates.set(descriptor.id, {
      ...current,
      options: [
        ...current.options,
        ...descriptor.options.filter((option) => !optionIds.has(option.id)),
      ],
      ...(promptInjectedValues.length > 0 ? { promptInjectedValues } : {}),
    });
  }

  return [...templates.values()];
}

function capabilityOptionLabel(id: string): string {
  const words = id.replaceAll(/[-_]+/g, " ").trim();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : id;
}

export function makeSelectCustomModelCapabilityDescriptor(
  template: SelectProviderOptionDescriptor,
  supportedValues: ReadonlyArray<string>,
  requestedDefault: string | undefined,
): SelectProviderOptionDescriptor | undefined {
  const templateIds = new Set(template.options.map((option) => option.id));
  const values = [
    ...new Set(
      supportedValues
        .map((value) => value.trim())
        .filter((value) => value && (template.id !== "contextWindow" || templateIds.has(value))),
    ),
  ];
  if (values.length === 0) {
    return undefined;
  }
  const defaultValue =
    requestedDefault && values.includes(requestedDefault) ? requestedDefault : values[0]!;
  const templateOptions = new Map(template.options.map((option) => [option.id, option]));
  const options = values.map((id) => {
    const templateOption = templateOptions.get(id);
    const { isDefault: _isDefault, ...rest } = templateOption ?? {
      id,
      label: capabilityOptionLabel(id),
    };
    return {
      ...rest,
      ...(id === defaultValue ? { isDefault: true } : {}),
    };
  });
  const promptInjectedValues = template.promptInjectedValues?.filter((value) =>
    values.includes(value),
  );

  return {
    id: template.id,
    label: template.label,
    type: "select",
    options,
    ...(template.description ? { description: template.description } : {}),
    currentValue: defaultValue,
    ...(promptInjectedValues && promptInjectedValues.length > 0 ? { promptInjectedValues } : {}),
  };
}
export function replaceCustomModelCapabilityDescriptor(
  configured: ReadonlyArray<ProviderOptionDescriptor>,
  descriptor: ProviderOptionDescriptor | undefined,
  id: string,
): ModelCapabilities {
  const next = configured.filter((candidate) => candidate.id !== id);
  if (descriptor) next.push(descriptor);
  return { optionDescriptors: next };
}

export function getConfiguredCustomModelOptionDescriptors(
  configured: ModelCapabilities | undefined,
  fallback: ModelCapabilities | null,
): ReadonlyArray<ProviderOptionDescriptor> {
  return configured === undefined
    ? (fallback?.optionDescriptors ?? [])
    : (configured.optionDescriptors ?? []);
}

function CustomModelCapabilitiesEditor(props: {
  readonly driverKind: ProviderDriverKind | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly model: ServerProviderModel;
  readonly value: ModelCapabilities | undefined;
  readonly onChange: (value: ModelCapabilities | undefined) => void;
}) {
  const configuredDescriptors = getConfiguredCustomModelOptionDescriptors(
    props.value,
    props.model.capabilities,
  );
  const templates = getCustomModelCapabilityTemplates(props.models, props.value);

  const replaceDescriptor = (descriptor: ProviderOptionDescriptor | undefined, id: string) => {
    props.onChange(replaceCustomModelCapabilityDescriptor(configuredDescriptors, descriptor, id));
  };

  return (
    <div className="grid gap-3">
      <div>
        <p className="text-xs font-medium text-foreground">Custom model controls</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Enable only controls supported by {props.model.name}. Separate values with commas.
        </p>
      </div>

      {templates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Provider has not reported configurable model controls.
        </p>
      ) : (
        templates.map((template) => {
          const configured = configuredDescriptors.find(
            (candidate) => candidate.id === template.id && candidate.type === template.type,
          );
          const enabled = configured !== undefined;

          const toggle = (checked: boolean) => {
            if (!checked) {
              replaceDescriptor(undefined, template.id);
              return;
            }
            if (template.type === "select") {
              const supportedValues = template.options.map((option) => option.id);
              const defaultValue =
                template.currentValue ??
                template.options.find((option) => option.isDefault)?.id ??
                supportedValues[0];
              replaceDescriptor(
                makeSelectCustomModelCapabilityDescriptor(template, supportedValues, defaultValue),
                template.id,
              );
              return;
            }
            replaceDescriptor(
              { ...template, currentValue: template.currentValue ?? false },
              template.id,
            );
          };

          return (
            <div key={template.id} className="rounded-md border border-border/70 p-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(checked) => toggle(Boolean(checked))}
                  aria-label={`Enable ${template.label} for ${props.model.name}`}
                />
                {template.label}
              </label>

              {enabled && configured?.type === "select" && template.type === "select" ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
                  <label className="grid gap-1 text-[11px] text-muted-foreground">
                    Supported values
                    <DraftInput
                      size="compact"
                      value={configured.options.map((option) => option.id).join(", ")}
                      onCommit={(value) => {
                        const supportedValues = value.split(",").map((entry) => entry.trim());
                        replaceDescriptor(
                          makeSelectCustomModelCapabilityDescriptor(
                            template,
                            supportedValues,
                            configured.currentValue,
                          ),
                          template.id,
                        );
                      }}
                      aria-label={`Supported ${template.label} values for ${props.model.name}`}
                      spellCheck={false}
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] text-muted-foreground">
                    Default
                    <Select
                      value={configured.currentValue ?? configured.options[0]?.id ?? ""}
                      onValueChange={(value) =>
                        replaceDescriptor(
                          makeSelectCustomModelCapabilityDescriptor(
                            template,
                            configured.options.map((option) => option.id),
                            value ?? undefined,
                          ),
                          template.id,
                        )
                      }
                    >
                      <SelectTrigger
                        size="compact"
                        className="w-full min-w-0"
                        aria-label={`Default ${template.label}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {configured.options.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </label>
                </div>
              ) : null}

              {enabled && configured?.type === "boolean" ? (
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>Default {configured.currentValue ? "On" : "Off"}</span>
                  <Switch
                    checked={configured.currentValue ?? false}
                    onCheckedChange={(checked) =>
                      replaceDescriptor(
                        { ...configured, currentValue: Boolean(checked) },
                        template.id,
                      )
                    }
                    aria-label={`Default ${template.label} for ${props.model.name}`}
                  />
                </div>
              ) : null}

              {template.id === "fastMode" && props.driverKind === CLAUDE_DRIVER_KIND ? (
                <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                  Claude fast mode is a Claude SDK setting. It is not OpenAI priority service.
                </p>
              ) : null}
              {template.id === "contextWindow" && props.driverKind === CLAUDE_DRIVER_KIND ? (
                <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                  1M adds Claude model selector at launch. Saved model ID stays unchanged.
                </p>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model slug list for this instance. Drives dedup,
   * and is the array we hand back verbatim (with the new slug appended /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<string>;
  readonly customModelCapabilities: Readonly<Record<string, ModelCapabilities>>;
  readonly onCustomModelCapabilitiesChange: (
    slug: string,
    capabilities: ModelCapabilities | undefined,
  ) => void;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model slugs favorited for this provider instance. */
  readonly favoriteModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  customModelCapabilities,
  onCustomModelCapabilitiesChange,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const orderedModels = useMemo(() => {
    return sortModelsForProviderInstance(models, {
      favoriteModels: favoriteModelSet,
      groupFavorites: true,
      modelOrder,
    });
  }, [favoriteModelSet, modelOrder, models]);

  const handleAdd = () => {
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    onChange([...customModels, normalized]);
    setInput("");
    setError(null);

    // Scroll the new row into view once the DOM reflects the commit.
    // `MutationObserver` handles the one-frame gap between `onChange` and
    // the `models` prop update; the `requestAnimationFrame` covers the
    // common case where the parent updates synchronously.
    const el = listRef.current;
    if (!el) return;
    const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    requestAnimationFrame(scrollToEnd);
    const observer = new MutationObserver(() => {
      scrollToEnd();
      observer.disconnect();
    });
    observer.observe(el, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 2_000);
  };

  const handleRemove = (slug: string) => {
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleToggleHidden = (slug: string) => {
    if (hiddenModelSet.has(slug)) {
      onHiddenModelsChange(hiddenModels.filter((model) => model !== slug));
      return;
    }
    onHiddenModelsChange([...hiddenModels, slug]);
  };

  const handleToggleFavorite = (slug: string) => {
    if (favoriteModelSet.has(slug)) {
      onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
      return;
    }
    onFavoriteModelsChange([...favoriteModels, slug]);
  };

  const handleMove = (slug: string, direction: -1 | 1) => {
    const slugs = orderedModels.map((model) => model.slug);
    const index = slugs.indexOf(slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= slugs.length) {
      return;
    }
    const next = [...slugs];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  return (
    <div>
      <div className="text-xs font-medium text-foreground">Models</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {models.length} model{models.length === 1 ? "" : "s"} available.
      </div>
      <div ref={listRef} className="mt-2 max-h-40 overflow-y-auto pb-1">
        {orderedModels.map((model, index) => {
          const caps = model.capabilities;
          const isHidden = !model.isCustom && hiddenModelSet.has(model.slug);
          const isFavorite = favoriteModelSet.has(model.slug);
          const previousModel = orderedModels[index - 1];
          const nextModel = orderedModels[index + 1];
          const canMoveUp =
            previousModel !== undefined && favoriteModelSet.has(previousModel.slug) === isFavorite;
          const canMoveDown =
            nextModel !== undefined && favoriteModelSet.has(nextModel.slug) === isFavorite;
          const descriptors = caps?.optionDescriptors ?? [];
          const capLabels = [...new Set(descriptors.map((descriptor) => descriptor.label))];
          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

          return (
            <div
              key={`${instanceId}:${model.slug}`}
              className={cn(
                "grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1",
                isHidden && "text-muted-foreground",
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className={cn(
                    "min-w-0 truncate text-xs",
                    isHidden ? "text-muted-foreground line-through" : "text-foreground/90",
                  )}
                >
                  {model.name}
                </span>
                {hasDetails ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost"
                          className="text-muted-foreground/60 hover:text-muted-foreground"
                          aria-label={`Details for ${model.name}`}
                        />
                      }
                    >
                      <InfoIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-56">
                      <div className="space-y-1">
                        <code className="block text-[11px] text-foreground">{model.slug}</code>
                        {capLabels.length > 0 ? (
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                            {capLabels.map((label) => (
                              <span key={label} className="text-[10px] text-muted-foreground">
                                {label}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {isHidden ? (
                  <span className="text-[10px] text-muted-foreground">hidden</span>
                ) : null}
                {model.isCustom ? (
                  <span className="text-[10px] text-muted-foreground">custom</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        className={cn(isFavorite && "text-yellow-500 hover:text-yellow-600")}
                        onClick={() => handleToggleFavorite(model.slug)}
                        aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
                          isFavorite ? "from" : "to"
                        } favorites`}
                      />
                    }
                  >
                    <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {isFavorite ? "Remove from favorites" : "Add to favorites"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={!canMoveUp}
                        onClick={() => handleMove(model.slug, -1)}
                        aria-label={`Move ${model.name} up`}
                      />
                    }
                  >
                    <ArrowUpIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Move up</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={!canMoveDown}
                        onClick={() => handleMove(model.slug, 1)}
                        aria-label={`Move ${model.name} down`}
                      />
                    }
                  >
                    <ArrowDownIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Move down</TooltipPopup>
                </Tooltip>
                {!model.isCustom ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          onClick={() => handleToggleHidden(model.slug)}
                          aria-label={`${isHidden ? "Show" : "Hide"} ${model.name}`}
                        />
                      }
                    >
                      {isHidden ? (
                        <EyeIcon className="size-3" />
                      ) : (
                        <EyeOffIcon className="size-3" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {isHidden ? "Show in picker" : "Hide from picker"}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {model.isCustom ? (
                  <Popover>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <PopoverTrigger
                            render={
                              <Button
                                size="icon-micro"
                                variant="ghost-muted"
                                aria-label={`Configure capabilities for ${model.slug}`}
                              />
                            }
                          />
                        }
                      >
                        <Settings2Icon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Configure model controls</TooltipPopup>
                    </Tooltip>
                    <PopoverPopup
                      side="left"
                      align="start"
                      className="w-[min(24rem,calc(100vw-1.5rem))] [--popup-width:min(24rem,calc(100vw-1.5rem))]"
                    >
                      <CustomModelCapabilitiesEditor
                        driverKind={driverKind}
                        models={models}
                        model={model}
                        value={getDeclaredCustomModelCapabilities(
                          customModelCapabilities,
                          model.slug,
                        )}
                        onChange={(value) => onCustomModelCapabilitiesChange(model.slug, value)}
                      />
                    </PopoverPopup>
                  </Popover>
                ) : null}
                {model.isCustom ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          aria-label={`Remove ${model.slug}`}
                          onClick={() => handleRemove(model.slug)}
                        />
                      }
                    >
                      <XIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Remove custom model</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          id={`provider-instance-${instanceId}-custom-model`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
          spellCheck={false}
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
