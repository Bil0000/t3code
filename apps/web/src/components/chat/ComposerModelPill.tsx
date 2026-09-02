import {
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { Slider } from "@base-ui/react/slider";
import { memo, useState } from "react";
import { ChevronRightIcon, ZapIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { DraftId } from "../../composerDraftStore";
import { Badge } from "../ui/badge";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Separator } from "../ui/separator";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import {
  effortFraction,
  nextSelectOptionId,
  resolveEffortDescriptor,
  resolveFastMode,
  type SelectTraitDescriptor,
} from "./composerModelPillTraits";
import {
  type ModelPickerPopoverProps,
  ModelPickerPopover,
  useModelPickerTriggerDisplay,
} from "./ProviderModelPicker";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  applyTraitSelectChange,
  buildTraitsTriggerDisplay,
  getTraitsSectionVisibility,
  replaceDescriptorCurrentValue,
  useUpdateModelOptions,
} from "./TraitsPicker";

type Traits = ReturnType<typeof getTraitsSectionVisibility>;
type EffortTone = "normal" | "peak" | "ultracode" | "ultrathink";

interface EffortState {
  index: number;
  label: string;
  tone: EffortTone;
  locked: boolean;
}

function resolveEffortState(descriptor: SelectTraitDescriptor, traits: Traits): EffortState {
  const isPrimary = descriptor.id === traits.primarySelectDescriptor?.id;
  const currentValue =
    isPrimary && traits.ultrathinkPromptControlled
      ? "ultrathink"
      : getProviderOptionCurrentValue(descriptor);
  const index = Math.max(
    0,
    descriptor.options.findIndex((option) => option.id === currentValue),
  );
  const option = descriptor.options[index];
  const tone: EffortTone =
    option?.id === "ultrathink"
      ? "ultrathink"
      : option?.id === "ultracode"
        ? "ultracode"
        : effortFraction(index, descriptor.options.length) >= 1
          ? "peak"
          : "normal";
  return {
    index,
    label: option?.label ?? "",
    tone,
    locked: isPrimary && traits.ultrathinkInBodyText,
  };
}

function accentClassName(provider: ProviderDriverKind): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : "text-primary";
}

function effortLabelClassName(tone: EffortTone, provider: ProviderDriverKind): string {
  if (tone === "ultrathink") return "ultrathink-word";
  if (tone === "ultracode") return "composer-effort-ultracode-text";
  if (tone === "peak") return "composer-effort-peak-text";
  return accentClassName(provider);
}

export const ComposerModelPill = memo(function ComposerModelPill(
  props: ModelPickerPopoverProps & {
    provider: ProviderDriverKind;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
    threadRef?: ScopedThreadRef;
    draftId?: DraftId;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    planModeEnabled: boolean;
    activeProviderIconClassName?: string;
    compact?: boolean;
  },
) {
  const { activeEntry, triggerTitle, triggerLabel, showInstanceBadge, isUnavailable } =
    useModelPickerTriggerDisplay(props);
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [uncontrolledListOpen, setUncontrolledListOpen] = useState(false);
  const isListOpen = props.open ?? uncontrolledListOpen;
  const setListOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) setUncontrolledListOpen(open);
  };
  const openList = () => {
    setIsCardOpen(false);
    setListOpen(true);
  };

  const persistence = {
    ...(props.threadRef ? { threadRef: props.threadRef } : {}),
    ...(props.draftId ? { draftId: props.draftId } : {}),
  };
  const updateModelOptions = useUpdateModelOptions({
    provider: props.provider,
    instanceId: props.activeInstanceId,
    model: props.model,
    persistence,
  });
  const traits = getTraitsSectionVisibility({
    provider: props.provider,
    models: props.models,
    model: props.model,
    prompt: props.prompt,
    modelOptions: props.modelOptions,
    planModeEnabled: props.planModeEnabled,
  });
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };
  const hasTraits = traits.hasAnyControls && !traits.modelIsUnavailable;
  const fastMode = hasTraits ? resolveFastMode(props.provider, traits.descriptors) : null;
  const effortDescriptor = hasTraits ? resolveEffortDescriptor(traits.descriptors) : null;
  const effort = effortDescriptor ? resolveEffortState(effortDescriptor, traits) : null;
  const chipDescriptors = hasTraits
    ? traits.descriptors.filter(
        (descriptor) => descriptor.id !== fastMode?.descriptorId && descriptor !== effortDescriptor,
      )
    : [];

  const modelName = (
    <span className="flex min-w-0 items-center gap-1.5">
      {activeEntry ? (
        <ProviderInstanceIcon
          driverKind={activeEntry.driverKind}
          displayName={activeEntry.displayName}
          accentColor={activeEntry.accentColor}
          showBadge={showInstanceBadge}
          className="size-4"
          iconClassName={cn("size-4", props.activeProviderIconClassName)}
          indicatorBackground="var(--contrast-input)"
          badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
        />
      ) : null}
      <span className="min-w-0 truncate text-foreground">{triggerTitle}</span>
      {isUnavailable ? (
        <Badge variant="outline" size="sm">
          Unavailable
        </Badge>
      ) : null}
    </span>
  );

  const triggerSummary = buildTraitsTriggerDisplay({
    provider: props.provider,
    descriptors: hasTraits ? traits.descriptors : [],
    primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled: traits.ultrathinkPromptControlled,
  });
  const showTraitsTrigger = hasTraits && !props.compact;

  return (
    <>
      <ModelPickerPopover
        {...props}
        open={isListOpen}
        onOpenChange={setListOpen}
        triggerRender={
          <ComposerControl
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-between whitespace-nowrap",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56",
            )}
            disabled={props.disabled}
            aria-label={triggerLabel}
          />
        }
        triggerChildren={
          <>
            {modelName}
            <ComposerControlChevron />
          </>
        }
      />
      {showTraitsTrigger ? (
        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      ) : null}
      <Popover open={isCardOpen && showTraitsTrigger} onOpenChange={setIsCardOpen}>
        <PopoverTrigger
          render={
            <ComposerControl
              className={cn(
                "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48",
                !showTraitsTrigger && "hidden",
              )}
              disabled={props.disabled}
              aria-label="Model options"
            />
          }
        >
          {triggerSummary.showFastModeIcon ? (
            <ComposerControlIcon
              icon={ZapIcon}
              className={cn("fill-current opacity-80", accentClassName(props.provider))}
            />
          ) : null}
          <span className="min-w-0 truncate">{triggerSummary.label}</span>
          <ComposerControlChevron />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          sideOffset={8}
          className="composer-model-card"
          viewportClassName="p-0"
        >
          <div className="flex flex-col gap-2 p-2">
            <div className="flex items-center gap-1">
              {fastMode ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className={cn(
                          "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-[background-color,color,transform] duration-200 hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring active:scale-90",
                          fastMode.enabled ? accentClassName(props.provider) : "text-icon-muted",
                        )}
                        aria-pressed={fastMode.enabled}
                        disabled={props.disabled}
                        onClick={() =>
                          updateDescriptors(
                            replaceDescriptorCurrentValue(
                              traits.descriptors,
                              fastMode.descriptorId,
                              fastMode.toggledValue,
                            ),
                          )
                        }
                      />
                    }
                  >
                    <ZapIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4.5 transition-[fill] duration-200",
                        fastMode.enabled ? "fill-current" : "fill-transparent",
                      )}
                    />
                    <span className="sr-only">
                      {fastMode.enabled ? "Fast mode on" : "Fast mode off"}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top" align="start" className="text-sm leading-snug">
                    <div>{fastMode.enabled ? "Fast mode on" : "Fast mode"}</div>
                    <div className="text-muted-foreground">Faster output, more usage</div>
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <button
                type="button"
                className="flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-base font-medium outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${triggerLabel}. Choose another model`}
                onClick={openList}
              >
                {modelName}
                {effort ? (
                  <span
                    key={effort.label}
                    className={cn(
                      "composer-model-pill-chip-enter shrink-0 transition-colors duration-300",
                      effortLabelClassName(effort.tone, props.provider),
                    )}
                  >
                    {effort.label}
                  </span>
                ) : null}
                <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-icon-muted" />
              </button>
            </div>

            {effortDescriptor && effort ? (
              <EffortSlider
                descriptor={effortDescriptor}
                effort={effort}
                provider={props.provider}
                traits={traits}
                prompt={props.prompt}
                onPromptChange={props.onPromptChange}
                updateDescriptors={updateDescriptors}
                disabled={props.disabled}
              />
            ) : null}

            {chipDescriptors.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1 px-0.5">
                {chipDescriptors.map((descriptor) => (
                  <TraitChip
                    key={descriptor.id}
                    descriptor={descriptor}
                    descriptors={traits.descriptors}
                    updateDescriptors={updateDescriptors}
                    disabled={props.disabled}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
});

function EffortSlider(props: {
  descriptor: SelectTraitDescriptor;
  effort: EffortState;
  provider: ProviderDriverKind;
  traits: Traits;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  updateDescriptors: (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => void;
  disabled?: boolean | undefined;
}) {
  const { descriptor, effort, traits } = props;
  const options = descriptor.options;

  const selectIndex = (index: number) => {
    const option = options[index];
    if (!option || index === effort.index) return;
    applyTraitSelectChange({
      descriptor,
      value: option.id,
      descriptors: traits.descriptors,
      primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
      ultrathinkPromptControlled: traits.ultrathinkPromptControlled,
      ultrathinkInBodyText: traits.ultrathinkInBodyText,
      prompt: props.prompt,
      onPromptChange: props.onPromptChange,
      updateDescriptors: props.updateDescriptors,
    });
  };

  return (
    <div className="px-1 pb-1">
      {effort.locked ? (
        <div className="mb-2 max-w-64 text-muted-foreground/80 text-xs">
          Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this option.
        </div>
      ) : null}
      <Slider.Root
        value={effort.index}
        min={0}
        max={Math.max(1, options.length - 1)}
        step={1}
        disabled={effort.locked || props.disabled}
        thumbAlignment="edge"
        onValueChange={(value) => selectIndex(value)}
        className="w-64 touch-none select-none"
        data-effort-tone={effort.tone}
        data-provider={props.provider}
      >
        <Slider.Control className="flex h-8 items-center">
          <Slider.Track className="composer-effort-track relative h-8 w-full rounded-full">
            <Slider.Indicator className="composer-effort-fill h-full rounded-full" />
            {options.map((option, index) => (
              <span
                key={option.id}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute top-1/2 size-1 -translate-y-1/2 rounded-full bg-foreground/30 transition-opacity duration-300",
                  index <= effort.index && "opacity-0",
                )}
                style={{
                  left: `calc(1rem + (100% - 2rem) * ${effortFraction(index, options.length)})`,
                }}
              />
            ))}
            <Slider.Thumb
              className="composer-effort-thumb size-7 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.45)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
              getAriaValueText={(_formatted, value) => options[value]?.label ?? ""}
              aria-label={descriptor.label}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
    </div>
  );
}

function TraitChip(props: {
  descriptor: ProviderOptionDescriptor;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  updateDescriptors: (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => void;
  disabled?: boolean | undefined;
}) {
  const { descriptor } = props;
  const currentLabel = getProviderOptionCurrentLabel(descriptor) ?? "";
  const setValue = (value: string | boolean) =>
    props.updateDescriptors(replaceDescriptorCurrentValue(props.descriptors, descriptor.id, value));
  const isOn = descriptor.type === "boolean" ? descriptor.currentValue === true : true;
  const chipLabel = descriptor.type === "boolean" ? descriptor.label : currentLabel;
  const chipClassName = cn(
    "flex h-6 cursor-pointer items-center rounded-md px-1.5 text-xs font-semibold tabular-nums outline-none transition-[background-color,color,transform] duration-200 hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring active:scale-95 disabled:pointer-events-none disabled:opacity-64",
    isOn ? "text-foreground" : "text-icon-muted",
  );
  const chipContent = (
    <span key={chipLabel} className="composer-model-pill-chip-enter">
      {chipLabel}
    </span>
  );

  if (descriptor.type === "select" && descriptor.options.length > 3) {
    return (
      <Menu>
        <MenuTrigger
          render={<button type="button" className={chipClassName} disabled={props.disabled} />}
        >
          {chipContent}
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuRadioGroup
            value={getProviderOptionCurrentValue(descriptor) ?? ""}
            onValueChange={(value) => {
              if (typeof value === "string" && value) setValue(value);
            }}
          >
            {descriptor.options.map((option) => (
              <MenuRadioItem key={option.id} value={option.id} hideIndicator closeOnClick>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    );
  }

  const onClick = () => {
    if (descriptor.type === "boolean") {
      setValue(!isOn);
      return;
    }
    const next = nextSelectOptionId(descriptor);
    if (next) setValue(next);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={chipClassName}
            disabled={props.disabled}
            onClick={onClick}
            aria-pressed={descriptor.type === "boolean" ? isOn : undefined}
            aria-label={`${descriptor.label}: ${currentLabel}`}
          />
        }
      >
        {chipContent}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {descriptor.label}: {currentLabel}. Click to switch.
      </TooltipPopup>
    </Tooltip>
  );
}
