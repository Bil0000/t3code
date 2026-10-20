import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeBrowserAgentThreadReadPermissions } from "./agentThreadReadPermissions";

it.effect("revokes the exact source pair across clients before storage events", () =>
  Effect.gen(function* () {
    const values = new Map<string, string>();
    const localStorage: Storage = {
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    };
    const first = makeBrowserAgentThreadReadPermissions(
      Object.assign(new EventTarget(), { localStorage }),
    );
    const second = makeBrowserAgentThreadReadPermissions(
      Object.assign(new EventTarget(), { localStorage }),
    );
    const entry = (id: string) => ({
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(id),
        label: id,
        httpBaseUrl: "https://" + id + ".test",
        wsBaseUrl: "wss://" + id + ".test",
      }),
      profile: Option.none(),
      enabled: true,
    });
    const source = entry("source");
    const destination = entry("destination");
    const other = entry("other");
    expect(yield* first.get(source, destination)).toBe(false);
    yield* first.set(source, destination, true);
    yield* second.set(other, destination, true);
    expect(yield* second.get(source, destination)).toBe(true);
    yield* first.set(source, destination, false);
    expect(yield* second.get(source, destination)).toBe(false);
    expect(yield* first.get(other, destination)).toBe(true);
    expect(yield* first.get(destination, other)).toBe(false);
    yield* second.forget(destination.target.environmentId);
    expect(values.size).toBe(0);
  }),
);
