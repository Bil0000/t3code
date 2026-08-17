import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { LinearConnection, LinearDisconnectInput } from "./issueTracking.ts";

describe("Linear connection contracts", () => {
  it("decodes more than one saved account without exposing tokens", () => {
    const decoded = Schema.decodeUnknownSync(LinearConnection)({
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      teams: [],
      accounts: [
        {
          credentialId: "user-1",
          status: "authenticated",
          accountName: "Ada",
          accountEmail: "ada@example.com",
          teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
        {
          credentialId: "user-2",
          status: "authenticated",
          accountName: "Grace",
          accountEmail: "grace@example.com",
          teams: [{ id: "team-2", key: "OPS", name: "Operations" }],
        },
      ],
    });

    expect(decoded.accounts.map(({ credentialId }) => credentialId)).toEqual(["user-1", "user-2"]);
    expect(JSON.stringify(decoded)).not.toContain("lin_api_");
  });

  it("accepts old disconnect calls without a payload", () => {
    expect(Schema.decodeUnknownSync(LinearDisconnectInput)(undefined)).toBeUndefined();
  });

  it("accepts the credential being disconnected", () => {
    expect(Schema.decodeUnknownSync(LinearDisconnectInput)({ credentialId: " user-1 " })).toEqual({
      credentialId: "user-1",
    });
  });
});
