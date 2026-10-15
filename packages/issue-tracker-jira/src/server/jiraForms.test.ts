import { expect, it } from "@effect/vitest";
import {
  createReserved,
  transitionReserved,
  jiraFieldValues,
  jiraInputFields,
  type JiraFieldMetadata,
} from "./jiraForms.ts";

const metadata: Record<string, JiraFieldMetadata> = {
  customfield_1: {
    name: "Notes",
    required: true,
    schema: {
      type: "string",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
    },
  },
  customfield_2: { name: "When", schema: { type: "date" } },
  customfield_3: { name: "At", schema: { type: "datetime" } },
  customfield_4: {
    name: "Choices",
    schema: { type: "array", items: "option" },
    allowedValues: [
      { id: "1", value: "One" },
      { id: "2", value: "Two" },
    ],
  },
  customfield_5: {
    name: "Plugin",
    schema: { type: "string", custom: "plugin:object" },
    allowedValues: ["opaque"],
  },
  customfield_6: {
    name: "Default",
    required: true,
    hasDefaultValue: true,
    schema: { type: "string" },
  },
};
it("sends native dates, multi-select options, ADF textarea and explicit plugin JSON", () => {
  const values = {
    customfield_1: "Notes",
    customfield_2: "2026-10-15",
    customfield_3: "2026-10-15T12:30:00Z",
    customfield_4: ["2", "1"],
    customfield_5: '{"native":true}',
  };
  const result = jiraFieldValues(metadata, values, createReserved, true);
  expect(result).toMatchObject({
    customfield_1: { type: "doc", version: 1 },
    customfield_2: values.customfield_2,
    customfield_3: values.customfield_3,
    customfield_4: [{ id: "2" }, { id: "1" }],
    customfield_5: { native: true },
  });
  expect(result).not.toHaveProperty("customfield_6");
  expect(jiraFieldValues(metadata, values, createReserved, false).customfield_1).toBe("Notes");
  expect(jiraInputFields(metadata, createReserved)).toContainEqual({
    id: "customfield_6",
    label: "Default",
    required: false,
    kind: "text",
  });
});
it.each(["", "2026-02-30", "2026-13-01", "15/10/2026"])("rejects invalid dates: %s", (value) => {
  expect(() =>
    jiraFieldValues(
      { customfield_2: metadata.customfield_2! },
      { customfield_2: value },
      createReserved,
      true,
    ),
  ).toThrow();
});
it("preserves required transition fields, including native descriptions", () => {
  const fields = {
    description: {
      required: true,
      name: "Description",
      schema: { type: "string", system: "description" },
    },
  };
  expect(jiraInputFields(fields, transitionReserved)).toEqual([
    { id: "description", label: "Description", required: true, kind: "textarea" },
  ]);
  expect(() => jiraFieldValues(fields, {}, transitionReserved, true)).toThrow();
  expect(
    jiraFieldValues(fields, { description: "Required" }, transitionReserved, true),
  ).toMatchObject({ description: { type: "doc" } });
});
it("refuses immutable fields, non-settable fields, missing required values and unsafe JSON", () => {
  expect(() =>
    jiraInputFields({ status: { schema: { type: "string" } } }, transitionReserved),
  ).toThrow();
  expect(() =>
    jiraFieldValues(
      { customfield_1: { required: true, operations: ["add"], schema: { type: "string" } } },
      {},
      createReserved,
      true,
    ),
  ).toThrow();
  expect(() => jiraFieldValues(metadata, { customfield_1: "" }, createReserved, true)).toThrow();
  expect(() =>
    jiraFieldValues(
      metadata,
      { customfield_1: "a", customfield_5: '{"constructor":{}}' },
      createReserved,
      true,
    ),
  ).toThrow();
});
it("uses native string options and unknown schema objects without losing values", () => {
  const fields = {
    customfield_7: {
      name: "String choice",
      schema: { type: "string" },
      allowedValues: ["red", "blue"],
    },
    customfield_8: {
      name: "String choices",
      schema: { type: "array", items: "string" },
      allowedValues: ["red", "blue"],
    },
    customfield_9: { name: "Unknown", schema: {} },
  };
  expect(jiraInputFields(fields, createReserved).map((field) => field.kind)).toEqual([
    "select",
    "multiselect",
    "json",
  ]);
  expect(
    jiraFieldValues(
      fields,
      { customfield_7: "red", customfield_8: ["blue"], customfield_9: '{"native":1}' },
      createReserved,
      true,
    ),
  ).toEqual({ customfield_7: "red", customfield_8: ["blue"], customfield_9: { native: 1 } });
});
