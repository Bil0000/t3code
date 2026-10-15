import type { IssueFieldValues, IssueInputField } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function nativeFieldValues(fields: readonly IssueInputField[], values: IssueFieldValues) {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.id];
      if (value === undefined) return [];
      if (
        !field.required &&
        typeof value === "string" &&
        !value.trim() &&
        field.kind !== "text" &&
        field.kind !== "textarea" &&
        field.kind !== "multiselect" &&
        !(field.kind === "select" && field.options?.some((option) => option.value === value))
      )
        return [];
      const native =
        field.kind === "datetime" && typeof value === "string" && value.trim()
          ? new Date(value).toISOString()
          : value;
      return [[field.id, native]];
    }),
  ) as IssueFieldValues;
}

export function nativeFieldError(fields: readonly IssueInputField[], values: IssueFieldValues) {
  for (const field of fields) {
    const value = values[field.id];
    const empty =
      value === undefined || (typeof value === "string" ? !value.trim() : !value.length);
    if (empty) {
      if (field.required) return `Fill in ${field.label}.`;
      continue;
    }
    if (field.kind === "multiselect") {
      if (
        typeof value === "string" ||
        value.some((item) => !field.options?.some((option) => option.value === item))
      )
        return `Choose values for ${field.label}.`;
    } else if (typeof value !== "string") return `Enter a value for ${field.label}.`;
    else if (field.kind === "select" && !field.options?.some((option) => option.value === value))
      return `Choose a value for ${field.label}.`;
    else if (field.kind === "number" && !Number.isFinite(Number(value)))
      return `Enter a number for ${field.label}.`;
    else if (field.kind === "datetime" && !Number.isFinite(new Date(value).getTime()))
      return `Enter a date and time for ${field.label}.`;
    else if (field.kind === "json") {
      try {
        JSON.parse(value);
      } catch {
        return `Enter valid JSON for ${field.label}.`;
      }
    }
  }
  return null;
}

export function IssueNativeFields({
  fields,
  values,
  onChange,
  disabled = false,
}: {
  fields: readonly IssueInputField[];
  values: IssueFieldValues;
  onChange: (values: IssueFieldValues) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4">
      {fields.map((field) => {
        const id = `issue-native-field-${field.id}`;
        const value = values[field.id];
        const text = typeof value === "string" ? value : "";
        const multiple = field.kind === "multiselect";
        const set = (next: string | readonly string[]) => onChange({ ...values, [field.id]: next });
        return (
          <div key={field.id} className="flex flex-col gap-1.5">
            <Label htmlFor={id}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            {field.description ? (
              <p className="text-xs text-muted-foreground">{field.description}</p>
            ) : null}
            {field.kind === "select" || multiple ? (
              <Select
                multiple={multiple}
                value={
                  multiple
                    ? Array.isArray(value)
                      ? [...value]
                      : []
                    : value === undefined
                      ? null
                      : text
                }
                disabled={disabled}
                onValueChange={(next: string | string[] | null) =>
                  set(next ?? (multiple ? [] : ""))
                }
              >
                <SelectTrigger id={id} size="sm" aria-label={field.label}>
                  <SelectValue>
                    {(selected: string | string[] | null) => {
                      const selectedValues = Array.isArray(selected)
                        ? selected
                        : selected !== null
                          ? [selected]
                          : [];
                      return (
                        selectedValues
                          .map(
                            (item) =>
                              field.options?.find((option) => option.value === item)?.label ?? item,
                          )
                          .join(", ") || (selected === "" ? "None" : "Select…")
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {!multiple &&
                  !field.required &&
                  !field.options?.some((option) => option.value === "") ? (
                    <SelectItem value="">None</SelectItem>
                  ) : null}
                  {field.options?.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : field.kind === "textarea" || field.kind === "json" ? (
              <Textarea
                id={id}
                value={text}
                required={field.required}
                maxLength={65_536}
                onChange={(event) => set(event.target.value)}
              />
            ) : (
              <Input
                id={id}
                value={text}
                required={field.required}
                maxLength={65_536}
                type={
                  field.kind === "datetime"
                    ? "datetime-local"
                    : field.kind === "text"
                      ? "text"
                      : field.kind
                }
                onChange={(event) => set(event.target.value)}
              />
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
