import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { EnvironmentReadRegistration, EnvironmentReadRequest } from "./environmentRead.ts";

const isReadRequest = Schema.is(EnvironmentReadRequest);
const isRegistration = Schema.is(EnvironmentReadRegistration);

describe("environment read boundary", () => {
  it("accepts only the five fixed read operations", () => {
    for (const operation of ["thread.send", "thread.delete", "project.create", "rpc", "fetch"]) {
      expect(isReadRequest({ operation, threadId: "thread", url: "https://example.invalid" })).toBe(
        false,
      );
    }
    expect(
      isReadRequest({ operation: "thread.read", threadId: "thread", maxCharsPerItem: 50_001 }),
    ).toBe(false);
    expect(isReadRequest({ operation: "thread.search", query: "topic", cursor: -1 })).toBe(false);
    expect(isReadRequest({ operation: "project.list", limit: 101 })).toBe(false);
  });

  it("allows explicit archived reads and bounds advertised destinations", () => {
    expect(
      isReadRequest({
        operation: "thread.search",
        projectId: "project",
        query: "topic",
        archived: "only",
        cursor: 50,
        limit: 50,
      }),
    ).toBe(true);
    expect(
      isReadRequest({
        operation: "thread.list",
        projectId: "project",
        archived: "include",
        cursor: 100,
      }),
    ).toBe(true);
    expect(isReadRequest({ operation: "thread.list", archived: "include" })).toBe(false);
    expect(isRegistration({ clientId: "client", environments: [] })).toBe(true);
    expect(
      isRegistration({
        clientId: "client",
        environments: Array.from({ length: 101 }, (_, index) => ({
          environmentId: `remote-${index}`,
          name: "Remote",
          status: "online",
        })),
      }),
    ).toBe(false);
  });
});
