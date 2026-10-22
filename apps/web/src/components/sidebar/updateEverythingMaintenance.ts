import type { ServerProvider } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

export interface HostedMaintenanceSnapshot {
  readonly ready: boolean;
  readonly machines: readonly {
    readonly hostedByThisApp: boolean;
    readonly connected: boolean;
    readonly sessionReady: boolean;
    readonly providers: readonly Pick<ServerProvider, "updateState">[];
  }[];
}

export function isHostedMaintenanceReady(snapshot: HostedMaintenanceSnapshot): boolean {
  const hosted = snapshot.machines.filter((machine) => machine.hostedByThisApp);
  return (
    snapshot.ready &&
    hosted.length > 0 &&
    hosted.every(
      (machine) =>
        machine.connected &&
        machine.sessionReady &&
        machine.providers.every(
          (provider) =>
            provider.updateState?.status !== "queued" && provider.updateState?.status !== "running",
        ),
    )
  );
}

export function waitForHostedMaintenance(
  registry: AtomRegistry.AtomRegistry,
  source: Atom.Atom<HostedMaintenanceSnapshot>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const inspect = () => {
      const snapshot = registry.get(source);
      const hosted = snapshot.machines.filter((machine) => machine.hostedByThisApp);
      if (
        !snapshot.ready ||
        hosted.length === 0 ||
        hosted.some((machine) => !machine.connected || !machine.sessionReady)
      ) {
        unsubscribe();
        reject(new Error("A local connection is not ready"));
        return;
      }
      if (!isHostedMaintenanceReady(snapshot)) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = registry.subscribe(source, inspect);
    inspect();
  });
}
