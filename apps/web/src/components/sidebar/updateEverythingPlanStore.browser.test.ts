import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { randomUUID } from "~/lib/utils";
import { openUpdatePlanStore } from "./updateEverythingPlanStore";
import type { UpdateExecutionPlan } from "./updateEverythingPlan";
import { runUpdatePlan, type UpdatePlanPorts } from "./updateEverythingPlan";

function plan(): UpdateExecutionPlan {
  return {
    schemaVersion: 1,
    id: "first",
    primaryEnvironmentId: EnvironmentId.make("primary"),
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "servers",
    pausedReason: null,
    items: [
      {
        key: "server",
        kind: "server",
        environmentId: EnvironmentId.make("remote"),
        label: "remote",
        fromVersion: "1.0.0",
        targetVersion: "1.0.1",
        driver: null,
        instanceId: null,
        continueThreads: false,
        status: "pending",
        claimId: null,
        message: null,
      },
    ],
  };
}

it("two IndexedDB connections cannot replace the single active plan", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using first = await openUpdatePlanStore(name);
  await using second = await openUpdatePlanStore(name);
  const saves = await Promise.all([
    first.create(plan()),
    second.create({ ...plan(), id: "second" }),
  ]);
  expect(saves.filter(Boolean)).toHaveLength(1);
  expect((await second.read())?.id).toBe(saves[0] ? "first" : "second");
});

it("rejects malformed data and future schemas before any change", async () => {
  await using store = await openUpdatePlanStore(`update-plan-test-${randomUUID()}`);
  await expect(
    store.change(() => ({ ...plan(), schemaVersion: 2 }) as unknown as UpdateExecutionPlan),
  ).rejects.toThrow();
  expect(await store.read()).toBeNull();
});

it("aborts a failed write without publishing an active plan", async () => {
  await using store = await openUpdatePlanStore(`update-plan-test-${randomUUID()}`);
  using _put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  await expect(store.create(plan())).rejects.toThrow("Storage full");
  expect(await store.read()).toBeNull();
});

it("can explicitly discard an unreadable future plan so selection can be reviewed again", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using store = await openUpdatePlanStore(name);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("plan", "readwrite");
      transaction.objectStore("plan").put({ ...plan(), schemaVersion: 2 }, "active");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
    await expect(store.read()).rejects.toThrow();
    await store.discard();
    expect(await store.read()).toBeNull();
  } finally {
    database.close();
  }
});

it("two real database runners send one server command and keep tools behind its completion", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using first = await openUpdatePlanStore(name);
  await using second = await openUpdatePlanStore(name);
  const initial = plan();
  await first.create({
    ...initial,
    items: [...initial.items, { ...initial.items[0]!, key: "tool", kind: "provider" }],
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const calls: string[] = [];
  const ports: UpdatePlanPorts = {
    claimId: "a",
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: (_item, recovering) => ({ status: recovering ? "wait" : "ready" }),
    download: async () => true,
    maintenanceReady: () => true,
    waitForMaintenance: async () => {},
    countdown: async () => true,
    install: async () => true,
    execute: async (item) => {
      calls.push(item.kind);
      if (item.kind === "server") {
        entered();
        await finished;
      }
      return { status: "done" };
    },
  };
  const running = Promise.all([
    runUpdatePlan(first, ports),
    runUpdatePlan(second, { ...ports, claimId: "b" }),
  ]);
  await started;
  expect(calls).toEqual(["server"]);
  expect((await second.read())?.items[0]?.status).toBe("claimed");
  complete();
  await running;
  expect(calls).toEqual(["server", "provider"]);
  expect((await first.read())?.phase).toBe("complete");
});
