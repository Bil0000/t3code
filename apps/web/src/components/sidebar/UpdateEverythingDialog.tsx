import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { environmentThreadShells } from "~/state/threads";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type {
  RestartingMachine,
  UpdateItemKey,
  UpdatePickerDevice,
  UpdatePickerItem,
} from "./updateEverything.logic";

const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .reduce(
        (count, id) =>
          count +
          get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).filter(
            (thread) => isRunning(thread.status),
          ).length,
        0,
      ),
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentIds}`)),
);

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly devices: ReadonlyArray<UpdatePickerDevice>;
  readonly onConfirm: (selection: ReadonlySet<UpdateItemKey>) => void;
}

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  devices,
  onConfirm,
}: UpdateEverythingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <UpdateEverythingForm devices={devices} onConfirm={onConfirm} />
      </DialogPopup>
    </Dialog>
  );
}

function selectableItems(device: UpdatePickerDevice): UpdatePickerItem[] {
  return device.unavailableReason === null
    ? device.items.filter((item) => item.disabledReason === null)
    : [];
}

function checkState(keys: ReadonlyArray<UpdateItemKey>, selected: ReadonlySet<UpdateItemKey>) {
  const count = keys.filter((key) => selected.has(key)).length;
  return {
    count,
    checked: count > 0 && count === keys.length,
    indeterminate: count > 0 && count < keys.length,
  };
}

function versionTrail({ fromVersion, toVersion }: UpdatePickerItem): string {
  const to = toVersion ?? "latest";
  return fromVersion === null ? to : `${fromVersion} → ${to}`;
}

function UpdateEverythingForm({
  devices,
  onConfirm,
}: Pick<UpdateEverythingDialogProps, "devices" | "onConfirm">) {
  const [selected, setSelected] = useState<ReadonlySet<UpdateItemKey>>(
    () => new Set(devices.flatMap(selectableItems).map((item) => item.key)),
  );
  const setKeys = (keys: ReadonlyArray<UpdateItemKey>, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const allItems = devices.flatMap(selectableItems);
  const chosen = allItems.filter((item) => selected.has(item.key));
  const all = checkState(
    allItems.map((item) => item.key),
    selected,
  );
  const restartsFirst = chosen.some((item) => item.kind === "app");

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length === 0) return;
        onConfirm(new Set(chosen.map((item) => item.key)));
      }}
    >
      <DialogHeader>
        <DialogTitle>Choose updates</DialogTitle>
        <DialogDescription>
          {restartsFirst
            ? "This device updates and restarts first. Then other devices, then tools."
            : "Devices update first, then their tools."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {devices.map((device) => (
          <UpdateDeviceGroup
            key={device.id}
            device={device}
            selected={selected}
            onToggle={setKeys}
          />
        ))}
        <RestartWarning restarts={chosen.flatMap((item) => item.restarts)} />
      </DialogPanel>
      <DialogFooter>
        {devices.length > 1 && allItems.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm sm:mr-auto">
            <Checkbox
              checked={all.checked}
              indeterminate={all.indeterminate}
              onCheckedChange={(checked) =>
                setKeys(
                  allItems.map((item) => item.key),
                  checked === true,
                )
              }
            />
            <span>All</span>
            <span className="text-muted-foreground tabular-nums">
              {all.count} of {allItems.length}
            </span>
          </label>
        ) : null}
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={chosen.length === 0}>
          Update
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateDeviceGroup({
  device,
  selected,
  onToggle,
}: {
  readonly device: UpdatePickerDevice;
  readonly selected: ReadonlySet<UpdateItemKey>;
  readonly onToggle: (keys: ReadonlyArray<UpdateItemKey>, checked: boolean) => void;
}) {
  const keys = selectableItems(device).map((item) => item.key);
  const state = checkState(keys, selected);
  const name = <span className="min-w-0 flex-1 truncate font-medium">{device.label}</span>;

  return (
    <section
      aria-label={device.label}
      className="rounded-xl bg-zinc-25 p-1 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5"
    >
      {device.unavailableReason !== null ? (
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          {name}
          <span className="max-w-1/2 text-right text-muted-foreground text-xs">
            {device.unavailableReason}
          </span>
        </div>
      ) : (
        <>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default has-disabled:hover:bg-transparent">
            <Checkbox
              checked={state.checked}
              indeterminate={state.indeterminate}
              disabled={keys.length === 0}
              onCheckedChange={(checked) => onToggle(keys, checked === true)}
            />
            {name}
            {keys.length > 0 ? (
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {state.count} of {keys.length}
              </span>
            ) : null}
          </label>
          <ul>
            {device.items.map((item) => (
              <UpdateItemRow
                key={item.key}
                item={item}
                checked={item.disabledReason === null && selected.has(item.key)}
                onCheckedChange={(checked) => onToggle([item.key], checked)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function UpdateItemRow({
  item,
  checked,
  onCheckedChange,
}: {
  readonly item: UpdatePickerItem;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const detailId = useId();
  const detail = item.disabledReason ?? item.note;

  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg py-1.5 pr-2 pl-8 hover:bg-muted/40 has-disabled:cursor-default has-disabled:hover:bg-transparent">
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            checked={checked}
            disabled={item.disabledReason !== null}
            onCheckedChange={(value) => onCheckedChange(value === true)}
            {...(detail !== null ? { "aria-describedby": detailId } : {})}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="max-w-full truncate">{item.label}</span>
            {item.context !== null ? (
              <span className="min-w-0 max-w-full truncate text-muted-foreground text-xs">
                {item.context}
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums wrap-anywhere">
            {versionTrail(item)}
          </span>
          {detail !== null ? (
            <span id={detailId} className="text-muted-foreground text-xs wrap-anywhere">
              {detail}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function RestartWarning({ restarts }: { readonly restarts: ReadonlyArray<RestartingMachine> }) {
  const unique = [...new Map(restarts.map((machine) => [machine.environmentId, machine])).values()];
  const idsWhere = (continues: boolean) =>
    unique
      .filter((machine) => machine.continuesThreads === continues)
      .map((machine) => machine.environmentId)
      .join("\n");
  const stopped = useAtomValue(runningThreadCountAtom(idsWhere(false)));
  const continuing = useAtomValue(runningThreadCountAtom(idsWhere(true)));
  const running = stopped + continuing;
  if (running === 0) return null;
  const threads = `${running} running ${running === 1 ? "thread" : "threads"}`;

  return (
    <p role="note" className="px-1 text-sm">
      {stopped === 0
        ? `${threads} will be interrupted and can resume after the restart.`
        : continuing === 0
          ? `${threads} will be interrupted.`
          : `${threads} will be interrupted. ${continuing} can resume after the restart.`}
    </p>
  );
}
