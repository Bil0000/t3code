import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { runUpdatePlan, type UpdateExecutionPlan } from "./updateEverythingPlan";
import { updatePlanStore } from "./updateEverythingPlanStore";
import {
  startUpdatePlan,
  UpdateEverythingCoordinator,
  useUpdateEverythingRun,
} from "./updateEverythingRun";

const toast = vi.hoisted(() => vi.fn());
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

vi.mock(import("./updateEverythingPlan"), async (original) => ({
  ...(await original()),
  runUpdatePlan: vi.fn(),
}));

vi.mock(import("./updateEverythingOptions"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    updateOptionsSnapshotAtom: Atom.make({
      ready: true,
      primaryEnvironmentId: null,
      localEnvironmentDisabled: true,
      machines: [],
    }),
  };
});

vi.mock(import("./updateEverythingPlanStore"), async (original) => {
  const module = await original();
  const { randomUUID } = await import("~/lib/utils");
  const store = module.openUpdatePlanStore(`update-run-test-${randomUUID()}`);
  return { ...module, updatePlanStore: () => store };
});

function Progress() {
  const run = useUpdateEverythingRun();
  return (
    <output>
      {run?.machines
        .map((machine) => `${machine.label}: ${machine.result ?? "pending"}`)
        .join(", ")}
    </output>
  );
}

it("publishes committed device results while another update is still running", async () => {
  const store = await updatePlanStore();
  await store.discard();
  const plan: UpdateExecutionPlan = {
    schemaVersion: 1,
    id: "progress",
    primaryEnvironmentId: null,
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "providers",
    pausedReason: null,
    items: ["fast", "failed", "slow"].map((key) => ({
      key,
      kind: "provider",
      environmentId: EnvironmentId.make(key),
      label: key,
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
      driver: null,
      instanceId: null,
      continueThreads: false,
      status: "pending",
      claimId: null,
      message: null,
    })),
  };
  await store.create(plan);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runner = vi.mocked(runUpdatePlan).mockReset();
  runner.mockImplementationOnce(async () => {
    entered();
    await finished;
  });
  try {
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <UpdateEverythingCoordinator />
        <Progress />
      </RegistryContext.Provider>,
    );
    await started;
    expect(
      (await navigator.locks.query()).held?.some(
        (lock) => lock.name === `t3code-update-plan-owner:${runner.mock.calls[0]![1].claimId}`,
      ),
    ).toBe(true);
    let publishOld!: (plan: UpdateExecutionPlan) => void;
    const oldRead = new Promise<UpdateExecutionPlan>((resolve) => {
      publishOld = resolve;
    });
    using _read = vi.spyOn(store, "read").mockImplementationOnce(() => oldRead);
    await store.change((current) => current && { ...current, items: [...current.items] });
    await store.change(
      (current) =>
        current && {
          ...current,
          items: current.items.map((item) => ({
            ...item,
            status: item.key === "fast" ? "done" : item.key === "failed" ? "failed" : "claimed",
            message: item.key === "failed" ? "Install failed" : null,
          })),
        },
    );
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("fast: done, failed: failed, slow: pending");
    expect(runner).toHaveBeenCalledTimes(1);
    await act(async () => {
      publishOld(plan);
      await oldRead;
    });
    expect(screen.getByRole("status").element().textContent).toBe(
      "fast: done, failed: failed, slow: pending",
    );
  } finally {
    finish();
    await finished;
    await store.discard();
  }
});

it("tells the user when none of the chosen updates can start", async () => {
  toast.mockReset();
  await expect(startUpdatePlan(new Set(["gone"]), null, false)).resolves.toEqual({
    status: "empty",
  });
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "info", title: "No selected updates can start right now." }),
  );
  expect(await (await updatePlanStore()).read()).toBeNull();
});
