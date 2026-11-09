import { RegistryContext } from "@effect/atom-react";
import {
  createDesktopChannelEnvironmentAtoms,
  createDesktopChannelHostAtom,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";

const atoms = createDesktopChannelEnvironmentAtoms(connectionAtomRuntime);

export function DesktopChannelHosts() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const environmentIdsKey = JSON.stringify(
    environments.map((environment) => environment.environmentId).sort(),
  );
  useEffect(() => {
    if (!isElectron || !window.desktopBridge?.remoteControl) return;
    const bridge = window.desktopBridge.remoteControl;
    let disposed = false;
    let revision = 0;
    const mounted = new Map<string, () => void>();
    const update = async (ids: readonly string[]) => {
      const version = ++revision;
      for (const [id, unmount] of mounted) {
        if (!ids.includes(id)) {
          unmount();
          mounted.delete(id);
        }
      }
      const identity = await bridge.getHostIdentity();
      if (disposed || version !== revision) return;
      for (const id of JSON.parse(environmentIdsKey) as string[]) {
        const environmentId = EnvironmentId.make(id);
        if (!ids.includes(environmentId) || mounted.has(environmentId)) continue;
        const host = { ...identity, environmentId, capabilities: { enabled: true } };
        const run = async <A, E>(
          result: Promise<import("@t3tools/client-runtime/state/runtime").AtomCommandResult<A, E>>,
        ) => {
          const settled = await result;
          if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
          return settled.value;
        };
        const consumer = createDesktopChannelHostAtom(
          atoms.connect({ environmentId, input: host }),
          {
            host,
            bridge,
            clock: { now: Date.now },
            rpc: {
              emit: (input) =>
                run(
                  runAtomCommand(
                    registry,
                    atoms.emit,
                    { environmentId, input },
                    { reportFailure: false, reportDefect: false },
                  ),
                ),
              respond: (input) =>
                run(
                  runAtomCommand(
                    registry,
                    atoms.respond,
                    { environmentId, input },
                    { reportFailure: false, reportDefect: false },
                  ),
                ),
            },
            onError: (error) => console.error("Desktop channel host failed", error),
          },
        );
        mounted.set(environmentId, registry.mount(consumer));
      }
    };
    const onError = (error: unknown) => console.error("Desktop channel setup failed", error);
    const unsubscribe = bridge.onEnabledEnvironmentIdsChanged((ids) => {
      void update(ids).catch(onError);
    });
    const initialRevision = revision;
    void bridge
      .getEnabledEnvironmentIds()
      .then((ids) => {
        if (revision === initialRevision && !disposed) return update(ids);
      })
      .catch(onError);
    return () => {
      disposed = true;
      unsubscribe();
      for (const unmount of mounted.values()) unmount();
    };
  }, [environmentIdsKey, registry]);
  return null;
}
