import type { ProviderAuthState, ServerProvider } from "@t3tools/contracts";

export const providerLoginLabels = {
  codex: {
    account: "Codex account",
    signIn: "Sign in with ChatGPT",
    signOut: "Sign out of Codex?",
    name: "Codex",
  },
  claudeAgent: {
    account: "Claude account",
    signIn: "Sign in with Claude",
    signOut: "Sign out of Claude?",
    name: "Claude",
  },
  grok: {
    account: "Grok account",
    signIn: "Sign in with Grok",
    signOut: "Sign out of Grok?",
    name: "Grok",
  },
} as const;

export type LoginProvider = keyof typeof providerLoginLabels;

export function supportsProviderLogin(driver: string): driver is LoginProvider {
  return driver === "codex" || driver === "claudeAgent" || driver === "grok";
}

/** Shared presentation rules keep both clients from showing stale device codes. */
export function providerLoginView(
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
  const authorizationCode =
    available && state?.phase === "waiting" && state.interaction?.type === "authorizationCode"
      ? state.interaction
      : null;
  const message = !provider?.enabled
    ? "Enable this instance to sign in."
    : !available
      ? "Browser sign-in is unavailable for this instance's authentication settings."
      : state === null
        ? "Reading sign-in status."
        : active || state.phase === "failed" || state.phase === "cancelled"
          ? (state.message ?? "Waiting for sign-in.")
          : signedIn || state.phase === "succeeded"
            ? "Signed in."
            : (state.message ?? "Sign in with your account.");
  return {
    available,
    active,
    signedIn,
    deviceCode,
    authorizationCode,
    authorizationUrl: deviceCode?.url ?? authorizationCode?.url ?? null,
    message,
    canStart: available && state !== null && !active && !signedIn,
    canCancel: available && active && state?.flowId != null,
    canLogout: available && state !== null && !active && signedIn,
  };
}
