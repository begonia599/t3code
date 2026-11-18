import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type AntigravitySettings,
  type ProviderSetupError,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import type { AntigravityQuota } from "./antigravityUsageLimits.ts";
import {
  makeUsageLimits,
  makeUnavailableUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "../providerUsageLimits.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const hasTier = Schema.is(
  Schema.Struct({
    antigravity: Schema.Struct({ tier: Schema.Struct({ name: Schema.String, id: Schema.String }) }),
  }),
);
const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAX_WORKSPACE_SNAPSHOTS = 32;
const HEALTH_CHECK_TIMEOUT = "90 seconds";
const SIGN_IN_MESSAGE = "Sign in with Google to use Antigravity.";
const AUTH_UNCHECKED_MESSAGE =
  "Antigravity is installed. Google account access is not checked yet.";

type SessionSetupResult = Pick<
  AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

/** Keep the native model IDs, including model-specific thinking levels. */
export function buildAntigravityModelsFromSession(
  setup: SessionSetupResult,
): ReadonlyArray<ServerProviderModel> {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentValue =
    config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : config === undefined
        ? (setup.models?.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
          })) ?? [])
        : [];
  const seen = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    return [
      {
        slug: entry.value,
        name: entry.name.trim() ? entry.name : entry.value,
        isCustom: false,
        ...(entry.value === currentValue
          ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] }
          : {}),
        capabilities: EMPTY_MODEL_CAPABILITIES,
      },
    ];
  });
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete|does not publish/i.test(error.detail)
  );
}

interface AntigravityProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

interface AntigravityProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly probeQuota?: Effect.Effect<AntigravityQuota>;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
  /** Auth type and label published once a session authenticates. */
  readonly auth?: { readonly type: string; readonly label: string };
}

/** Health uses initialize only. Session callbacks supply account-specific metadata. */
export const makeAntigravityProvider = Effect.fn("makeAntigravityProvider")(function* (
  settings: AntigravitySettings,
  options: AntigravityProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: { displayName: "Antigravity", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        // The configured method rides along so the registry can tell a saved
        // account for this method from one left by a previous configuration.
        auth: { status: "unknown", ...(options.auth ? { type: options.auth.type } : {}) },
        message: settings.enabled
          ? "Checking Antigravity availability."
          : "Antigravity is disabled in T3 Code settings.",
      },
    }),
    setup: { canAuthenticate: true, canInstall: true },
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<AntigravityProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  const closed = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
  // Skills the driver discovered on disk per workspace. Session callbacks
  // rewrite the workspace entry with native commands and must keep these, or
  // the registry drops the suggestions and never re-reads the workspace.
  const discoveredSkills = new Map<string, ServerProvider["skills"]>();
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkAntigravityProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    const result = yield* options.probe.pipe(
      Effect.timeoutOption(HEALTH_CHECK_TIMEOUT),
      Effect.result,
    );
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const installedVersion = initialized?.agentInfo?.version;
    const legacyAuthLabel =
      installedVersion === "1.1.1" || installedVersion === "agy_acp_server_1.1.1"
        ? (options.auth?.label ?? "Google account")
        : undefined;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Antigravity could not complete its local health check."
          : missingInstallation
            ? "Antigravity is not installed or its executable could not be found."
            : failure
              ? "Antigravity could not complete its local health check."
              : `Antigravity did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const supportsTextGeneration =
      initialized !== undefined ? yield* options.supportsTextGeneration : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      const { usageLimits: _previousUsageLimits, ...draftWithoutUsageLimits } = draft;
      const authenticated = draft.auth.status === "authenticated";
      const message =
        errorMessage ??
        (authenticated
          ? undefined
          : draft.auth.status === "unauthenticated"
            ? SIGN_IN_MESSAGE
            : AUTH_UNCHECKED_MESSAGE);
      return {
        ...state,
        draft: {
          ...(missingInstallation ? draftWithoutUsageLimits : draft),
          installed: !missingInstallation,
          version: installedVersion || draft.version,
          ...(legacyAuthLabel && draft.auth.status !== "unauthenticated"
            ? { auth: { ...draft.auth, label: legacyAuthLabel } }
            : {}),
          status: errorMessage ? "error" : authenticated ? "ready" : "warning",
          checkedAt: updatedAt,
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(initialized !== undefined
            ? {
                supportsTextGeneration:
                  supportsTextGeneration && draft.auth.status !== "unauthenticated",
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies AntigravityProviderState;
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("antigravity"),
      packageName: null,
    });
  const managed = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
  });

  const quotaLock = yield* Semaphore.make(1);
  let accountGeneration = 0;
  let lastProbeAt = Number.NEGATIVE_INFINITY;

  const refreshQuota = Effect.fn("AntigravityProvider.refreshQuota")(
    function* (trigger: "manual" | "turn") {
      const probeQuota = options.probeQuota;
      if (!settings.enabled || !probeQuota) return;
      const state = yield* SubscriptionRef.get(metadata);
      if (!state.draft.installed || state.draft.auth.status === "unauthenticated") return;
      const generation = accountGeneration;
      const now = yield* Clock.currentTimeMillis;
      if (now - lastProbeAt < (trigger === "turn" ? 600_000 : 60_000)) return;
      lastProbeAt = now;
      const result = yield* probeQuota;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const probed =
        result.status === "probeFailed" || result.status === "unsupported"
          ? makeUnavailableUsageLimits({ checkedAt, reason: result.status })
          : makeUsageLimits({ checkedAt, windows: result.status === "ok" ? result.windows : [] });
      yield* SubscriptionRef.update(metadata, (current) => {
        if (generation !== accountGeneration || !current.draft.installed) return current;
        const usageLimits = resolveUsageLimitsAfterProbe({
          published: current.draft.usageLimits,
          probed,
        });
        return { ...current, draft: { ...current.draft, usageLimits } };
      });
    },
    quotaLock.withPermitsIfAvailable(1),
    Effect.asVoid,
  );

  function resetQuotaAccount() {
    accountGeneration++;
    lastProbeAt = Number.NEGATIVE_INFINITY;
  }

  const defaultAuth = {
    type: options.auth?.type ?? "oauth-personal",
    label: options.auth?.label ?? "Google account",
  };

  // Capture the account before acquiring the process. An old session may finish
  // authenticating after a new sign-in has already reset the snapshot.
  const makeTierObserver = () => {
    const generation = accountGeneration;
    let tierName: string | undefined;
    return (
      meta: EffectAcpSchema.AuthenticateResponse["_meta"],
      stage: "authenticate" | "session",
    ) => {
      if (hasTier(meta) && meta.antigravity.tier.name.trim()) tierName = meta.antigravity.tier.name;
      if (!tierName && stage === "authenticate") return Effect.void;
      const label = tierName ?? defaultAuth.label;
      return SubscriptionRef.update(metadata, (state) =>
        generation !== accountGeneration ||
        (state.draft.auth.status === "authenticated" && state.draft.auth.label === label)
          ? state
          : ({
              ...state,
              draft: { ...state.draft, auth: { status: "authenticated", ...defaultAuth, label } },
            } satisfies AntigravityProviderState),
      );
    };
  };

  const onSessionStarted = Effect.fn("AntigravityProvider.onSessionStarted")(function* (
    started: AcpSessionRuntimeStartResult,
    cwd?: string,
  ) {
    const before = yield* SubscriptionRef.get(metadata);
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (
        state.authRevision !== before.authRevision &&
        state.draft.auth.status === "unauthenticated"
      ) {
        return state;
      }
      const { message: _previousMessage, ...draft } = state.draft;
      const workspaces = draft.workspaceSnapshots ?? [];
      const workspace = cwd ? workspaces.find((entry) => entry.cwd === cwd) : undefined;
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: settings.enabled ? "ready" : "disabled",
          version: started.initializeResult.agentInfo?.version || draft.version,
          auth: {
            status: "authenticated",
            ...defaultAuth,
            label: draft.auth.label ?? defaultAuth.label,
          },
          checkedAt: updatedAt,
          models: buildAntigravityModelsFromSession(started.sessionSetupResult),
          supportsTextGeneration,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands: workspace?.slashCommands ?? draft.slashCommands,
                    skills: workspace?.skills ?? discoveredSkills.get(cwd) ?? [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies AntigravityProviderState;
    });
  });

  const onConfigOptionsUpdated = Effect.fn("AntigravityProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) {
    const models = buildAntigravityModelsFromSession({ configOptions });
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status !== "authenticated") return state;
      return { ...state, draft: { ...state.draft, models } };
    });
  });

  const onAvailableCommands = Effect.fn("AntigravityProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status === "unauthenticated") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          slashCommands,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...(state.draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands,
                    skills:
                      state.draft.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills ??
                      discoveredSkills.get(cwd) ??
                      [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      };
    });
  });

  const clearAccountMetadata = Effect.fn("AntigravityProvider.clearAccountMetadata")(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      resetQuotaAccount();
      const { usageLimits: _previousUsageLimits, ...draft } = state.draft;
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          auth: { status: "unauthenticated" },
          status: settings.enabled ? "warning" : "disabled",
          message: SIGN_IN_MESSAGE,
          checkedAt: updatedAt,
          models: [],
          slashCommands: [],
          skills: [],
          workspaceSnapshots: [],
          supportsTextGeneration: false,
        },
      } satisfies AntigravityProviderState;
    });
    discoveredSkills.clear();
  });

  const snapshotForCwd = Effect.fn("AntigravityProvider.snapshotForCwd")(function* (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    if (skills) {
      discoveredSkills.set(cwd, skills);
      // A rescan replaces the stored entry's skills. Session callbacks and
      // health checks republish that entry, so it must not keep old ones.
      yield* SubscriptionRef.update(metadata, (state) =>
        state.draft.workspaceSnapshots?.some((entry) => entry.cwd === cwd)
          ? {
              ...state,
              draft: {
                ...state.draft,
                workspaceSnapshots: state.draft.workspaceSnapshots.map((entry) =>
                  entry.cwd === cwd ? { ...entry, skills } : entry,
                ),
              },
            }
          : state,
      );
    }
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    const resolvedSkills = skills ?? workspace?.skills ?? discoveredSkills.get(cwd) ?? [];
    return workspace
      ? { ...snapshot, slashCommands: workspace.slashCommands, skills: resolvedSkills }
      : { ...snapshot, skills: resolvedSkills };
  });

  return {
    snapshot: {
      ...managed,
      getSnapshot,
      refresh: managed.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: SubscriptionRef.changes(metadata).pipe(
        Stream.mapEffect((state) => options.stampIdentity(state.draft)),
        Stream.interruptWhen(Deferred.await(closed)),
      ),
    },
    refreshQuota,
    makeTierObserver,
    onSignInStarted: SubscriptionRef.update(metadata, (state) => {
      resetQuotaAccount();
      const { usageLimits: _previousUsageLimits, ...draft } = state.draft;
      return {
        ...state,
        draft: {
          ...draft,
          auth:
            state.draft.auth.status === "authenticated"
              ? { status: "authenticated", ...defaultAuth }
              : { status: "unauthenticated" },
        },
      } satisfies AntigravityProviderState;
    }),
    onSessionStarted,
    onConfigOptionsUpdated,
    onAvailableCommands,
    onSignedOut: clearAccountMetadata(),
    onAuthRequired: clearAccountMetadata(),
    snapshotForCwd,
  };
});
