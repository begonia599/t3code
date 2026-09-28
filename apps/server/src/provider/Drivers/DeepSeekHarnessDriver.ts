import {
  DeepSeekHarnessSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepSeekHarnessAdapter } from "../Layers/DeepSeekHarnessAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("deepseekHarness");
const DEFAULT_MODEL = "deepseek-v4-flash";
const decodeSettings = Schema.decodeSync(DeepSeekHarnessSettings);
const capabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: "high",
      options: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
      ],
    },
  ],
});
const builtInModels: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_MODEL,
    name: "DeepSeek V4 Flash",
    isCustom: false,
    isDefault: true,
    capabilities,
  },
  { slug: "deepseek-flash", name: "DeepSeek Flash", isCustom: false, capabilities },
  { slug: "deepseek-v4-pro", name: "DeepSeek V4 Pro", isCustom: false, capabilities },
];

export type DeepSeekHarnessDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const DeepSeekHarnessDriver: ProviderDriver<
  DeepSeekHarnessSettings,
  DeepSeekHarnessDriverEnv
> = {
  driverKind: DRIVER,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: false },
  configSchema: DeepSeekHarnessSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const settingsService = yield* ServerSettingsService;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled } satisfies DeepSeekHarnessSettings;
      const identity = defaultProviderContinuationIdentity({ driverKind: DRIVER, instanceId });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: identity.continuationKey,
      });
      const models = providerModelsFromSettings(builtInModels, settings.customModels, capabilities);
      const snapshotFor = (probe: {
        installed: boolean;
        version: string | null;
        status: "ready" | "warning" | "error";
        message?: string;
      }) =>
        DateTime.now.pipe(
          Effect.map((time) => ({
            ...stampIdentity(
              buildServerProvider({
                presentation: {
                  displayName: "DeepSeek Harness",
                  badgeLabel: "Preview",
                  showInteractionModeToggle: false,
                  supportsConversationRollback: false,
                },
                enabled,
                checkedAt: DateTime.formatIso(time),
                models,
                probe: { ...probe, auth: { status: "unknown" } },
              }),
            ),
            supportsTextGeneration: false,
          })),
        );
      const checkProvider = Effect.gen(function* () {
        if (!enabled) {
          return yield* snapshotFor({
            installed: false,
            version: null,
            status: "warning",
            message: "DeepSeek Harness is disabled.",
          });
        }
        const command = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
          env: processEnvironment,
        });
        const result = yield* spawnAndCollect(
          settings.binaryPath,
          ChildProcess.make(command.command, command.args, {
            env: processEnvironment,
            shell: command.shell,
          }),
        ).pipe(Effect.timeoutOption(4_000), Effect.result);
        if (Result.isFailure(result)) {
          return yield* snapshotFor({
            installed: !isCommandMissingCause(result.failure),
            version: null,
            status: "error",
            message: isCommandMissingCause(result.failure)
              ? "Install @deepseek-ai/dsh or set its binary path."
              : "DeepSeek Harness could not be started.",
          });
        }
        if (Option.isNone(result.success)) {
          return yield* snapshotFor({
            installed: true,
            version: null,
            status: "error",
            message: "DeepSeek Harness version check timed out.",
          });
        }
        const output = result.success.value;
        return yield* snapshotFor({
          installed: true,
          version: parseGenericCliVersion(`${output.stdout}\n${output.stderr}`),
          status: output.code === 0 ? "ready" : "error",
          ...(output.code !== 0 ? { message: "DeepSeek Harness version check failed." } : {}),
        });
      });
      const adapter = yield* makeDeepSeekHarnessAdapter({
        instanceId,
        settings,
        makeRuntime: (options) =>
          AcpSessionRuntime.make({
            spawn: {
              command: settings.binaryPath,
              args: ["--profile", "acp"],
              cwd: options.cwd,
              env: processEnvironment,
            },
            cwd: options.cwd,
            resumeMethod: "resume",
            ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
            mcpServers: options.mcpServers,
            clientInfo: { name: "t3-code", version: "0.0.0" },
            authMethodId: "none",
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      });
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: "@deepseek-ai/dsh",
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(settings, settingsService);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<DeepSeekHarnessSettings>
      >({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          snapshotFor({
            installed: false,
            version: null,
            status: "warning",
            message: "Checking DeepSeek Harness CLI availability...",
          }),
        checkProvider: checkProvider.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not prepare the DeepSeek Harness provider.",
              cause,
            }),
        ),
      );
      const unavailable = (
        operation:
          | "generateCommitMessage"
          | "generatePrContent"
          | "generateBranchName"
          | "generateThreadTitle",
      ) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "DeepSeek Harness does not provide T3 Code background text generation.",
          }),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity: identity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: {
          generateCommitMessage: () => unavailable("generateCommitMessage"),
          generatePrContent: () => unavailable("generatePrContent"),
          generateBranchName: () => unavailable("generateBranchName"),
          generateThreadTitle: () => unavailable("generateThreadTitle"),
        },
      } satisfies ProviderInstance;
    }),
};
