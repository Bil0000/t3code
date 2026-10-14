import type { IssueTemplate, IssueTemplateField } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

const Field = Schema.Struct({
  type: Schema.Literals(["markdown", "input", "textarea", "dropdown", "checkboxes"]),
  id: Schema.optional(Schema.String),
  attributes: Schema.Struct({
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    placeholder: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    render: Schema.optional(Schema.String),
    multiple: Schema.optional(Schema.Boolean),
    default: Schema.optional(Schema.Number),
    options: Schema.optional(
      Schema.Array(
        Schema.Union([
          Schema.String,
          Schema.Struct({ label: Schema.String, required: Schema.optional(Schema.Boolean) }),
        ]),
      ),
    ),
  }),
  validations: Schema.optional(Schema.Struct({ required: Schema.optional(Schema.Boolean) })),
});
const Form = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  about: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.Array(Field),
  labels: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  assignees: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
const Config = Schema.Struct({
  blank_issues_enabled: Schema.optional(Schema.Boolean),
  contact_links: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String, url: Schema.String })),
  ),
});

function readYaml<S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(fromYaml(schema))(text));
}
const names = (value: string | ReadonlyArray<string> | undefined) =>
  typeof value === "string"
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : (value ?? []);

export function readGitHubIssueTemplateFiles(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly object: { readonly text?: string | null | undefined } | null;
  }>,
) {
  const templates: IssueTemplate[] = [];
  let config = {
    blankIssuesEnabled: true,
    contactLinks: [] as ReadonlyArray<{
      readonly name: string;
      readonly about: string;
      readonly url: string;
    }>,
  };
  for (const entry of entries) {
    if (entry.object?.text == null || !/\.ya?ml$/i.test(entry.name)) continue;
    if (/^config\.ya?ml$/i.test(entry.name)) {
      const parsed = readYaml(entry.object.text, Config);
      if (parsed !== undefined)
        config = {
          blankIssuesEnabled: parsed.blank_issues_enabled ?? true,
          contactLinks: parsed.contact_links ?? [],
        };
      continue;
    }
    const parsed = readYaml(entry.object.text, Form);
    if (parsed === undefined) continue;
    const fields = parsed.body.map((field, index): IssueTemplateField => {
      const attributes = field.attributes;
      if (field.type === "markdown") return { kind: "markdown", value: attributes.value ?? "" };
      const base = {
        id: field.id ?? `field-${index}`,
        label: attributes.label ?? "",
        description: attributes.description ?? null,
        required: field.validations?.required ?? false,
      };
      if (field.type === "input")
        return {
          ...base,
          kind: "input",
          placeholder: attributes.placeholder ?? null,
          value: attributes.value ?? null,
        };
      if (field.type === "textarea")
        return {
          ...base,
          kind: "textarea",
          placeholder: attributes.placeholder ?? null,
          value: attributes.value ?? null,
          render: attributes.render ?? null,
        };
      if (field.type === "dropdown") {
        const options = (attributes.options ?? []).map((option) =>
          typeof option === "string" ? option : option.label,
        );
        const defaultIndex = attributes.default;
        return {
          ...base,
          kind: "dropdown",
          multiple: attributes.multiple ?? false,
          options,
          ...(defaultIndex !== undefined &&
          Number.isInteger(defaultIndex) &&
          defaultIndex >= 0 &&
          defaultIndex < options.length
            ? { defaultValues: [options[defaultIndex]!] }
            : {}),
        };
      }
      return {
        ...base,
        kind: "checkboxes",
        options: (attributes.options ?? []).map((option) =>
          typeof option === "string"
            ? { label: option, required: false }
            : { label: option.label, required: option.required ?? false },
        ),
      };
    });
    templates.push({
      key: entry.name,
      name: parsed.name,
      about: parsed.description ?? parsed.about ?? "",
      title: parsed.title ?? "",
      body: "",
      fields,
      labels: names(parsed.labels),
      assignees: names(parsed.assignees),
    });
  }
  return { templates, ...config };
}
