import type { ProviderAuthState, ServerProvider } from "@t3tools/contracts";

/** Shared presentation rules keep both clients from showing stale device codes. */
export function codexDeviceAuthView(
  provider: ServerProvider | undefined,
  state: ProviderAuthState | null,
) {
  const available = provider?.enabled === true && provider.setup?.canAuthenticate === true;
  const active =
    state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
  const signedIn = provider?.auth.status === "authenticated";
  const deviceCode =
    available && state?.phase === "waiting" && state.interaction?.type === "deviceCode"
      ? state.interaction
      : null;
  const message = !provider?.enabled
    ? "Enable this Codex instance to sign in."
    : !available
      ? "Update this environment to sign in to Codex."
      : state === null
        ? "Reading sign-in status."
        : active || state.phase === "failed" || state.phase === "cancelled"
          ? (state.message ?? "Waiting for Codex sign-in.")
          : signedIn || state.phase === "succeeded"
            ? "Signed in to Codex."
            : (state.message ?? "Sign in with your ChatGPT account.");
  return {
    available,
    active,
    signedIn,
    deviceCode,
    message,
    canStart: available && state !== null && !active && !signedIn,
    canCancel: available && active && state?.flowId != null,
    canLogout: available && state !== null && !active && signedIn,
  };
}
