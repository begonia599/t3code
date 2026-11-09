import type {
  DesktopChannelCapabilities,
  DesktopExecLogEntry,
  RemoteControlBridge,
  RemoteControlConfig,
  RemoteControlGrant,
  RemoteControlGrantRequest,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "~/env";

import { bridgeErrorMessage } from "./remoteControl.logic";

/**
 * The desktop remote-control bridge, or null outside Electron and on desktop
 * shells that predate the executor (they only expose the M3 channel methods).
 */
export function readRemoteControlBridge(): RemoteControlBridge | null {
  if (!isElectron || typeof window === "undefined") return null;
  const bridge = window.desktopBridge?.remoteControl;
  return bridge && typeof bridge.getConfig === "function" ? bridge : null;
}

interface BridgeState<T> {
  readonly value: T | null;
  readonly error: string | null;
}

/**
 * Initial read plus push updates. A push that lands before the read settles
 * wins: it is at least as fresh as the read's snapshot.
 */
function useBridgeValue<T>(
  load: (bridge: RemoteControlBridge) => Promise<T>,
  subscribe: ((bridge: RemoteControlBridge, listener: (value: T) => void) => () => void) | null,
): BridgeState<T> & { readonly reload: () => void; readonly replace: (value: T) => void } {
  const [state, setState] = useState<BridgeState<T>>({ value: null, error: null });
  useEffect(() => {
    const bridge = readRemoteControlBridge();
    if (!bridge) return;
    let active = true;
    let pushed = false;
    const unsubscribe = subscribe
      ? subscribe(bridge, (value) => {
          if (!active) return;
          pushed = true;
          setState({ value, error: null });
        })
      : () => {};
    load(bridge).then(
      (value) => {
        if (active && !pushed) setState({ value, error: null });
      },
      (error: unknown) => {
        if (active && !pushed) {
          setState((current) => ({ value: current.value, error: bridgeErrorMessage(error) }));
        }
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [load, subscribe]);
  // A fresh read after a call whose result main pushes later (or not at all).
  const reload = useCallback(() => {
    const bridge = readRemoteControlBridge();
    if (!bridge) return;
    load(bridge).then(
      (value) => setState({ value, error: null }),
      (error: unknown) =>
        setState((current) => ({ value: current.value, error: bridgeErrorMessage(error) })),
    );
  }, [load]);
  // For results a call already returned, ahead of (or instead of) the push.
  const replace = useCallback((value: T) => setState({ value, error: null }), []);
  return { ...state, reload, replace };
}

const loadConfig = (bridge: RemoteControlBridge) => bridge.getConfig();
const subscribeConfig = (
  bridge: RemoteControlBridge,
  listener: (config: RemoteControlConfig) => void,
) => bridge.onConfigChanged(listener);

export function useRemoteControlConfig() {
  return useBridgeValue(loadConfig, subscribeConfig);
}

const loadEnabledEnvironmentIds = (bridge: RemoteControlBridge) =>
  bridge.getEnabledEnvironmentIds();
const subscribeEnabledEnvironmentIds = (
  bridge: RemoteControlBridge,
  listener: (ids: readonly string[]) => void,
) => bridge.onEnabledEnvironmentIdsChanged(listener);

export function useEnabledRemoteEnvironmentIds() {
  return useBridgeValue(loadEnabledEnvironmentIds, subscribeEnabledEnvironmentIds);
}

const loadGrants = (bridge: RemoteControlBridge) => bridge.listGrants();
const subscribeGrants = (
  bridge: RemoteControlBridge,
  listener: (grants: readonly RemoteControlGrant[]) => void,
) => bridge.onGrantsChanged(listener);

export function useRemoteControlGrants() {
  return useBridgeValue(loadGrants, subscribeGrants);
}

const loadPending = (bridge: RemoteControlBridge) => bridge.getPendingGrantRequests();
const subscribePending = (
  bridge: RemoteControlBridge,
  listener: (pending: readonly RemoteControlGrantRequest[]) => void,
) => bridge.onPendingGrantRequestsChanged(listener);

export function usePendingGrantRequests() {
  return useBridgeValue(loadPending, subscribePending);
}

const loadCapabilities = (bridge: RemoteControlBridge): Promise<DesktopChannelCapabilities> =>
  bridge.getCapabilities();

export function useRemoteControlCapabilities() {
  return useBridgeValue(loadCapabilities, null);
}

export const REMOTE_CONTROL_AUDIT_LIMIT = 50;
const AUDIT_REFRESH_MS = 15_000;

interface AuditState {
  readonly entries: readonly DesktopExecLogEntry[] | null;
  readonly error: string | null;
}

const readAudit = (bridge: RemoteControlBridge) =>
  bridge.readAudit({ limit: REMOTE_CONTROL_AUDIT_LIMIT });

/** Audit is a local log file; poll it gently while the settings page is open. */
export function useRemoteControlAudit() {
  const [state, setState] = useState<AuditState>({ entries: null, error: null });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const bridge = readRemoteControlBridge();
    if (!bridge) return;
    let active = true;
    const tick = () => {
      readAudit(bridge).then(
        (entries) => {
          if (active) setState({ entries, error: null });
        },
        (cause: unknown) => {
          if (active) {
            setState((current) => ({ entries: current.entries, error: bridgeErrorMessage(cause) }));
          }
        },
      );
    };
    tick();
    const timer = window.setInterval(tick, AUDIT_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const refresh = useCallback(async () => {
    const bridge = readRemoteControlBridge();
    if (!bridge) return;
    setLoading(true);
    try {
      setState({ entries: await readAudit(bridge), error: null });
    } catch (cause) {
      setState((current) => ({ entries: current.entries, error: bridgeErrorMessage(cause) }));
    } finally {
      setLoading(false);
    }
  }, []);
  return { ...state, loading, refresh };
}
