import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget } from "./model.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  agentThreadReadAllowed,
  makeAgentThreadReadPermissions,
  type StoredAgentThreadReadGrant,
} from "./agentThreadReadPermissions.ts";

function entry(id: string): ConnectionCatalogEntry {
  return {
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make(id),
      label: id,
      httpBaseUrl: "https://" + id + ".test",
      wsBaseUrl: "wss://" + id + ".test",
    }),
    profile: Option.none(),
    enabled: true,
  };
}
const source = entry("source");
const destination = entry("destination");
const other = entry("other");

describe("agent thread read grants", () => {
  it.effect("requires a directed pair and revokes both directions on removal", () =>
    Effect.gen(function* () {
      let stored: ReadonlyArray<StoredAgentThreadReadGrant> = [];
      const permissions = yield* makeAgentThreadReadPermissions({
        read: Effect.succeed(stored),
        write: (grants) =>
          Effect.sync(() => {
            stored = grants;
          }),
      });
      expect(yield* permissions.get(source, destination)).toBe(false);
      yield* permissions.set(source, destination, true);
      expect(yield* permissions.get(source, destination)).toBe(true);
      expect(yield* permissions.get(destination, source)).toBe(false);
      expect(yield* permissions.get(source, other)).toBe(false);
      expect(agentThreadReadAllowed(source, source, stored)).toBe(false);
      yield* permissions.set(destination, source, true);
      yield* permissions.forget(source.target.environmentId);
      expect(stored).toEqual([]);
      expect(yield* permissions.get(source, destination)).toBe(false);
    }),
  );

  it.effect("does not transfer a grant when either saved address changes", () =>
    Effect.gen(function* () {
      const permissions = yield* makeAgentThreadReadPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      yield* permissions.set(source, destination, true);
      const changed = (value: ConnectionCatalogEntry) => ({
        ...value,
        target: new PrimaryConnectionTarget({
          environmentId: value.target.environmentId,
          label: value.target.label,
          httpBaseUrl: "https://replacement.test",
          wsBaseUrl: "wss://replacement.test",
        }),
      });
      expect(yield* permissions.get(changed(source), destination)).toBe(false);
      expect(yield* permissions.get(source, changed(destination))).toBe(false);
      yield* permissions.set(source, destination, false);
      expect(yield* permissions.get(source, destination)).toBe(false);
    }),
  );
});
