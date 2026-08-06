import {
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES,
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  classifyPayloadSize,
  conversationPayload,
  partFileName,
  sha256,
} from "./ThreadHandoffService.ts";

describe("classifyPayloadSize", () => {
  it("passes an ordinary payload", () => {
    assert.strictEqual(classifyPayloadSize(4 * 1024 * 1024), "ok");
  });

  it("warns above the warning threshold but still allows the transfer", () => {
    assert.strictEqual(
      classifyPayloadSize(ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES + 1),
      "warn",
    );
  });

  it("treats the warning threshold itself as ordinary", () => {
    assert.strictEqual(classifyPayloadSize(ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES), "ok");
  });

  it("refuses above the hard ceiling", () => {
    assert.strictEqual(
      classifyPayloadSize(ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES + 1),
      "refuse",
    );
  });

  it("treats the ceiling itself as a warning rather than a refusal", () => {
    assert.strictEqual(classifyPayloadSize(ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES), "warn");
  });

  it("passes an empty payload", () => {
    assert.strictEqual(classifyPayloadSize(0), "ok");
  });
});

describe("partFileName", () => {
  it("names every part kind distinctly so staged parts cannot collide", () => {
    const names = [
      partFileName("git-bundle"),
      partFileName("tracked-patch"),
      partFileName("untracked-tar"),
      partFileName("attachments-tar"),
    ];

    assert.strictEqual(new Set(names).size, names.length);
  });
});

describe("sha256", () => {
  it("addresses identical bytes identically", () => {
    assert.strictEqual(
      sha256(new TextEncoder().encode("t3")),
      sha256(new TextEncoder().encode("t3")),
    );
  });

  it("addresses different bytes differently", () => {
    assert.notStrictEqual(
      sha256(new TextEncoder().encode("t3")),
      sha256(new TextEncoder().encode("t4")),
    );
  });

  it("produces the hex digest length the manifest schema requires", () => {
    assert.match(sha256(new Uint8Array([1, 2, 3])), /^[0-9a-f]{64}$/);
  });
});

describe("conversationPayload", () => {
  const projection = (runCount: number, itemCount: number) =>
    ({
      turnItems: Array.from({ length: itemCount }, (_, index) => ({ ordinal: index })),
      runs: Array.from({ length: runCount }, (_, index) => ({ id: `run-${index}` })),
    }) as unknown as OrchestrationV2ThreadProjection;

  it("covers every run the thread has, one ordinal per run", () => {
    assert.deepStrictEqual(conversationPayload(projection(3, 5)).coveredRunOrdinals, [1, 2, 3]);
  });

  it("covers nothing for a thread that has never run", () => {
    assert.deepStrictEqual(conversationPayload(projection(0, 0)).coveredRunOrdinals, []);
  });

  it("carries every turn item so the far side replays the whole conversation", () => {
    assert.strictEqual(conversationPayload(projection(2, 7)).items.length, 7);
  });
});
