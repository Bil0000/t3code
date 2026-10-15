import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { issueAccountRequest, IssueRef, IssueUpdateInput, ThreadIssueKey } from "./issue.ts";
import { ORCHESTRATION_V2_WS_METHODS, OrchestrationV2Command } from "./orchestrationV2.ts";
import { WsIssuesRpcGroup, WsRpcGroup, WS_METHODS } from "./rpc.ts";

const ref = {
  projectId: "project",
  tracker: "linear",
  host: "linear.app",
  scope: "acme/ENG",
  key: "ENG-7",
};
const scopes = { projectId: ref.projectId, tracker: ref.tracker, host: ref.host, scope: ref.scope };
const cases = [
  [WS_METHODS.issuesList, { state: "all" }],
  [WS_METHODS.issuesList, { state: "all", projectId: "project" }],
  [WS_METHODS.issuesResolveUrl, { url: "https://linear.app/acme/issue/ENG-7" }],
  [
    WS_METHODS.issuesResolveUrl,
    { url: "https://linear.app/acme/issue/ENG-7", projectId: "project" },
  ],
  [WS_METHODS.issuesDetail, ref],
  [WS_METHODS.issuesComments, { ...ref, cursor: "older" }],
  [WS_METHODS.issuesTemplates, scopes],
  [WS_METHODS.issuesCandidates, { ...scopes, key: "ENG-7" }],
  [WS_METHODS.issuesCreate, { ...scopes, title: "New", body: "", labels: [], assignees: [] }],
  [WS_METHODS.issuesComment, { ...ref, body: "Comment" }],
  [WS_METHODS.issuesUpdate, { ...ref, title: "Edit" }],
  [WS_METHODS.issuesSetState, { ...ref, state: "Done" }],
  [WS_METHODS.issuesReact, { ...ref, content: "thumbs-up", reacted: true }],
  [WS_METHODS.issuesHistory, ref],
  [WS_METHODS.issuesLinkedPullRequests, ref],
  [WS_METHODS.issuesHierarchy, ref],
  [WS_METHODS.issuesLabelCandidates, scopes],
  [WS_METHODS.issuesAssigneeCandidates, scopes],
  [WS_METHODS.issuesEditComment, { ...ref, commentId: "comment", body: "Edit" }],
  [WS_METHODS.issuesSetParent, { ...ref, parentKey: null }],
] as const;
const legacyProjectId = Schema.Struct({ projectId: Schema.optional(Schema.String) });
const legacyKey = Schema.Struct({ key: Schema.String });

const issueCodecs = new Map(
  [...WsIssuesRpcGroup.requests].map(([tag, rpc]) => [
    tag,
    {
      encode: Schema.encodeUnknownSync(rpc.payloadSchema),
      decode: Schema.decodeUnknownSync(rpc.payloadSchema),
    },
  ]),
);
const commandSchema = WsRpcGroup.requests.get(
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
)!.payloadSchema;
const encodeCommand = Schema.encodeUnknownSync(commandSchema);
const decodeCommand = Schema.decodeUnknownSync(commandSchema);
const decodeInternalCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeLegacyProject = Schema.decodeUnknownSync(legacyProjectId);
const decodeLegacyKey = Schema.decodeUnknownSync(legacyKey);
const decodeRef = Schema.decodeUnknownSync(IssueRef);
const encodeRef = Schema.encodeUnknownSync(IssueRef);
const encodeUpdate = Schema.encodeUnknownSync(IssueUpdateInput);
const encodeThreadKey = Schema.encodeUnknownSync(ThreadIssueKey);

describe("account-safe issue payloads", () => {
  it("retains constructor inputs for generated RPC clients", () => {
    const payload = issueAccountRequest(IssueRef);
    expectTypeOf<(typeof payload)["~type.make.in"]>().toEqualTypeOf<
      (typeof IssueRef)["~type.make.in"]
    >();
  });

  it.each(cases)(
    "keeps %s decoded targets plain and default wire values unchanged",
    (tag, input) => {
      const { encode, decode } = issueCodecs.get(tag)!;
      const plain = decode(input);
      expect(encode(plain)).toEqual(input);
      const selected = { ...input, connectionId: "Account" };
      const wire = encode(selected);
      expect(wire).toEqual({
        ...input,
        projectId: {
          ...("projectId" in input ? { value: input.projectId } : {}),
          connectionId: "Account",
        },
      });
      expect(decode(wire)).toEqual(selected);
      expect(() => decodeLegacyProject(wire)).toThrow();
      expect(() => decode(selected)).toThrow();
      expect(() => decode({ ...wire, connectionId: "account" })).toThrow();
    },
  );

  it("covers 18 targeted RPCs plus 5 refresh/settings RPCs", () => {
    const guarded = new Set(cases.map(([tag]) => tag));
    for (const [tag, input] of [
      [WS_METHODS.issuesRefreshThreadLinks, { threadId: "thread" }],
      [WS_METHODS.issueTrackersList, {}],
      [
        WS_METHODS.issueTrackersScopes,
        { tracker: "linear", cursor: "next", connectionId: "Account" },
      ],
      [WS_METHODS.issueTrackersConnect, { tracker: "linear", token: null }],
      [WS_METHODS.issueTrackersBindProject, { projectId: "project", binding: null }],
    ] as const) {
      const { encode, decode } = issueCodecs.get(tag)!;
      expect(encode(input)).toEqual(input);
      expect(decode(input)).toEqual(input);
      guarded.add(tag as (typeof cases)[number][0]);
    }
    expect([...WsIssuesRpcGroup.requests.keys()].sort()).toEqual([...guarded].sort());
    expect(guarded.size).toBe(23);
  });

  it.each(["thread.issue.link", "thread.issue.unlink", "thread.issue-link.sync"] as const)(
    "qualifies %s only at the dispatch transport",
    (type) => {
      const command = decodeInternalCommand({
        type,
        commandId: "command",
        threadId: "thread",
        ...ref,
        connectionId: "Account",
        url: "https://linear.app/acme/issue/ENG-7",
        source: "manual",
        snapshot: {
          displayKey: "ENG-7",
          title: "Issue",
          state: { category: "open", name: "Todo" },
          syncedAt: "2026-10-15T00:00:00Z",
        },
      });
      const encoded = encodeCommand(command);
      expect(encoded).toMatchObject({ key: { value: "ENG-7", connectionId: "Account" } });
      expect(decodeCommand(encoded)).toEqual(command);
      expect(() => decodeLegacyKey(encoded)).toThrow();
      expect(() => decodeCommand(command)).toThrow();
      if (!("connectionId" in command)) throw new Error("Expected an issue command");
      const { connectionId: _connectionId, ...legacy } = command;
      expect(encodeCommand(legacy)).toEqual(legacy);
    },
  );

  it("keeps internal service and persisted schemas unchanged", () => {
    const selected = { ...ref, connectionId: "Account" };
    expect(decodeRef(selected)).toEqual(selected);
    expect(encodeRef(selected)).toEqual(selected);
    expect(encodeUpdate({ ...selected, title: "Edit" })).toEqual({
      ...selected,
      title: "Edit",
    });
    expect(encodeThreadKey(selected)).toEqual({
      tracker: "linear",
      host: "linear.app",
      scope: "acme/ENG",
      key: "ENG-7",
      connectionId: "Account",
    });
  });
});
