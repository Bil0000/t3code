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
import { ZapIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { DraftId } from "../../composerDraftStore";
import { Badge } from "../ui/badge";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControlChevron } from "./ComposerControl";
import {
  effortColor,
  effortFraction,
  nextSelectOptionId,
  resolveEffortDescriptor,
  resolveFastMode,
  type SelectTraitDescriptor,
} from "./composerModelPill";
import {
  type ModelPickerPopoverProps,
  ModelPickerPopover,
  useModelPickerTriggerDisplay,
} from "./ProviderModelPicker";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  applyTraitSelectChange,
  getTraitsSectionVisibility,
  replaceDescriptorCurrentValue,
  useUpdateModelOptions,
} from "./TraitsPicker";

const segmentClassName =
  "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-2 text-sm font-medium text-secondary-label outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64";

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
    /** Hide effort and trait chips; the compact menu carries them instead. */
    compact?: boolean;
  },
) {
  const { activeEntry, triggerTitle, triggerLabel, showInstanceBadge, isUnavailable } =
    useModelPickerTriggerDisplay(props);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isListOpen = props.open ?? uncontrolledOpen;
  const setListOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) setUncontrolledOpen(open);
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
  const fastMode = resolveFastMode(props.provider, traits.descriptors);
  const effortDescriptor = resolveEffortDescriptor(traits.descriptors);
  const chipDescriptors = traits.descriptors.filter(
    (descriptor) => descriptor.id !== fastMode?.descriptorId && descriptor !== effortDescriptor,
  );
  const showTraits = !props.compact && traits.hasAnyControls && !traits.modelIsUnavailable;

  return (
    <div
      className="inline-flex min-w-0 items-stretch overflow-hidden rounded-lg bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.06] dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]"
      data-chat-composer-model-pill="true"
    >
      {fastMode ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(segmentClassName, "pe-1")}
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
                "size-4 transition-[color,fill,transform] duration-200 active:scale-90",
                fastMode.enabled
                  ? cn(
                      "fill-current",
                      props.provider === "claudeAgent" ? "text-[#d97757]" : "text-primary",
                    )
                  : "fill-transparent text-icon-muted",
              )}
            />
            <span className="sr-only">{fastMode.enabled ? "Fast mode on" : "Fast mode off"}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {fastMode.enabled ? "Fast mode on" : "Fast mode off"} · click to switch
          </TooltipPopup>
        </Tooltip>
      ) : null}

      <ModelPickerPopover
        {...props}
        open={isListOpen}
        onOpenChange={setListOpen}
        triggerRender={
          <button
            type="button"
            data-chat-provider-model-picker="true"
            className={cn(
              segmentClassName,
              "min-w-0 shrink text-foreground",
              props.compact ? "max-w-42" : "max-w-48 sm:max-w-56",
            )}
            disabled={props.disabled}
          />
        }
        triggerChildren={
          <>
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
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                {triggerTitle}
              </TooltipTrigger>
              <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
            </Tooltip>
            {isUnavailable ? (
              <Badge variant="outline" size="sm">
                Unavailable
              </Badge>
            ) : null}
            {showTraits && effortDescriptor ? null : <ComposerControlChevron />}
          </>
        }
      />

      {showTraits && effortDescriptor ? (
        <EffortSegment
          descriptor={effortDescriptor}
          traits={traits}
          prompt={props.prompt}
          onPromptChange={props.onPromptChange}
          updateDescriptors={updateDescriptors}
          disabled={props.disabled}
          onOpenList={() => setListOpen(true)}
        />
      ) : null}

      {showTraits
        ? chipDescriptors.map((descriptor) => (
            <TraitChip
              key={descriptor.id}
              descriptor={descriptor}
              descriptors={traits.descriptors}
              updateDescriptors={updateDescriptors}
              disabled={props.disabled}
            />
          ))
        : null}
    </div>
  );
});

function EffortSegment(props: {
  descriptor: SelectTraitDescriptor;
  traits: ReturnType<typeof getTraitsSectionVisibility>;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  updateDescriptors: (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => void;
  disabled?: boolean | undefined;
  onOpenList: () => void;
}) {
  const { descriptor, traits } = props;
  const options = descriptor.options;
  const isPrimary = descriptor.id === traits.primarySelectDescriptor?.id;
  const ultrathinkActive = isPrimary && traits.ultrathinkPromptControlled;
  const currentValue = ultrathinkActive ? "ultrathink" : getProviderOptionCurrentValue(descriptor);
  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.id === currentValue),
  );
  const currentOption = options[currentIndex];
  const fraction = effortFraction(currentIndex, options.length);
  const color = effortColor(fraction);
  const locked = isPrimary && traits.ultrathinkInBodyText;
  const isUltrathink = currentOption?.id === "ultrathink";

  const selectIndex = (index: number) => {
    const option = options[index];
    if (!option || option.id === currentValue) return;
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
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={160}
        render={
          <button
            type="button"
            className={cn(segmentClassName, "ps-1 hover:text-current")}
            aria-label={`${descriptor.label}: ${currentOption?.label ?? ""}`}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("transition-colors duration-300", isUltrathink && "ultrathink-word")}
          style={isUltrathink ? undefined : { color }}
        >
          {currentOption?.label}
        </span>
        <span
          role="button"
          tabIndex={-1}
          aria-hidden="true"
          className="-me-1 flex h-full items-center px-0.5"
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenList();
          }}
        >
          <ComposerControlChevron />
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="center" viewportClassName="p-2.5">
        <div className="mb-2 flex items-center justify-between gap-4 text-xs">
          <span className="text-muted-foreground">{descriptor.label}</span>
          <span
            className={cn(
              "font-medium transition-colors duration-300",
              isUltrathink && "ultrathink-word",
            )}
            style={isUltrathink ? undefined : { color }}
          >
            {currentOption?.label}
          </span>
        </div>
        {locked ? (
          <div className="mb-2 max-w-56 text-muted-foreground/80 text-xs">
            Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
            option.
          </div>
        ) : null}
        <Slider.Root
          value={currentIndex}
          min={0}
          max={Math.max(1, options.length - 1)}
          step={1}
          disabled={locked || props.disabled}
          thumbAlignment="edge"
          onValueChange={(value) => selectIndex(value)}
          className="w-56 touch-none select-none"
        >
          <Slider.Control className="flex h-6 items-center">
            <Slider.Track className="relative h-6 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
              <Slider.Indicator
                className={cn(
                  "rounded-full transition-[width,background-color] duration-300 ease-out",
                  isUltrathink && "ultrathink-pill",
                )}
                style={
                  isUltrathink
                    ? undefined
                    : { background: `linear-gradient(90deg, ${effortColor(0)}, ${color})` }
                }
              />
              {options.map((option, index) => (
                <span
                  key={option.id}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 size-1 -translate-y-1/2 rounded-full bg-foreground/25"
                  style={{
                    left: `calc(0.75rem + ${effortFraction(index, options.length) * 100}% - ${effortFraction(index, options.length) * 1.5}rem - 0.125rem)`,
                  }}
                />
              ))}
              <Slider.Thumb
                className="size-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)] outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-ring data-dragging:scale-110"
                getAriaValueText={(_formatted, value) => options[value]?.label ?? ""}
                aria-label={descriptor.label}
              />
            </Slider.Track>
          </Slider.Control>
        </Slider.Root>
      </PopoverPopup>
    </Popover>
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
  const chipLabel = descriptor.type === "boolean" ? descriptor.label : currentLabel;
  const chipClassName = cn(
    segmentClassName,
    "text-xs",
    descriptor.type === "boolean" && descriptor.currentValue !== true && "opacity-60",
  );

  if (descriptor.type === "select" && descriptor.options.length > 3) {
    return (
      <Menu>
        <MenuTrigger
          render={<button type="button" className={chipClassName} disabled={props.disabled} />}
        >
          {chipLabel}
        </MenuTrigger>
        <MenuPopup align="start">
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            {descriptor.label}
          </div>
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
      setValue(descriptor.currentValue !== true);
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
            aria-label={`${descriptor.label}: ${currentLabel}`}
          />
        }
      >
        <span key={chipLabel} className="composer-model-pill-chip-enter">
          {chipLabel}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {descriptor.label}: {currentLabel} · click to switch
      </TooltipPopup>
    </Tooltip>
  );
}
