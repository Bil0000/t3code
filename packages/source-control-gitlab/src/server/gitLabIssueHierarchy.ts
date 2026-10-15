import * as Schema from "effect/Schema";

import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const WorkItem = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^gid:\/\/gitlab\/WorkItem\/[1-9]\d*$/)),
  iid: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  title: Schema.NonEmptyString,
  webUrl: Schema.NonEmptyString,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  confidential: Schema.Boolean,
  archived: Schema.Boolean,
  namespace: Schema.Struct({ fullPath: Schema.NonEmptyString }),
  project: Schema.NullOr(Schema.Struct({ fullPath: Schema.NonEmptyString })),
  workItemType: Schema.Struct({ name: Schema.NonEmptyString }),
  userPermissions: Schema.Struct({ adminParentLink: Schema.Boolean }),
});
export type GitLabWorkItem = typeof WorkItem.Type;

const WorkItemWithHierarchy = Schema.Struct({
  ...WorkItem.fields,
  widgets: Schema.Array(
    Schema.Struct({
      __typename: Schema.String,
      parent: Schema.optional(Schema.NullOr(WorkItem)),
      children: Schema.optional(
        Schema.Struct({
          nodes: Schema.Array(WorkItem),
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(Schema.String),
          }),
        }),
      ),
    }),
  ),
});
export type GitLabWorkItemWithHierarchy = typeof WorkItemWithHierarchy.Type;

const WORK_ITEM_FIELDS = `id iid title webUrl state confidential archived
  namespace { fullPath } project { fullPath } workItemType { name }
  userPermissions { adminParentLink }`;
const PARENT_FIELDS = `parent { ${WORK_ITEM_FIELDS} }`;

export const WORK_ITEM_QUERY = `query($fullPath: ID!, $iid: String!) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetHierarchy { ${PARENT_FIELDS} } }
    }
  }
}`;

export const WORK_ITEM_HIERARCHY_QUERY = `query($fullPath: ID!, $iid: String!, $first: Int!, $after: String) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetHierarchy {
        ${PARENT_FIELDS}
        children(first: $first, after: $after) {
          nodes { ${WORK_ITEM_FIELDS} } pageInfo { hasNextPage endCursor }
        }
      } }
    }
  }
}`;

export const WORK_ITEM_PARENT_MUTATION = `mutation($input: WorkItemUpdateInput!) {
  workItemUpdate(input: $input) {
    errors
    workItem {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetHierarchy { ${PARENT_FIELDS} } }
    }
  }
}`;

export const decodeWorkItemEnvelope = decodeJsonResult(
  Schema.Struct({
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  }),
);
export const decodeWorkItemJson = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      namespace: Schema.NullOr(Schema.Struct({ workItem: Schema.NullOr(WorkItemWithHierarchy) })),
    }),
  }),
);
export const decodeWorkItemMutationJson = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      workItemUpdate: Schema.Struct({
        errors: Schema.Array(Schema.String),
        workItem: Schema.NullOr(WorkItemWithHierarchy),
      }),
    }),
  }),
);
