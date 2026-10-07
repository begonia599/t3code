import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-driver-login-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Claude must not make an HTTP request")),
    ),
  ),
);
const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Claude must not spawn a process"),
);

it.layer(testLayer)("ClaudeDriver login", (it) => {
  for (const source of ["setting", "environment", "home"] as const) {
    it.effect(
      `coordinates credentials using the ${source} config directory without launching login`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-private-" });
          const configDirectory = source === "home" ? `${directory}/.claude` : directory;
          yield* fs.makeDirectory(configDirectory, { recursive: true });
          const instance = yield* ClaudeDriver.create({
            instanceId: ProviderInstanceId.make("claude-personal"),
            displayName: "Personal",
            enabled: false,
            environment:
              source === "environment"
                ? [{ name: "CLAUDE_CONFIG_DIR", value: directory, sensitive: false }]
                : source === "home"
                  ? [
                      { name: "HOME", value: directory, sensitive: false },
                      { name: "CLAUDE_CONFIG_DIR", value: "", sensitive: false },
                    ]
                  : [],
            config: {
              ...ClaudeDriver.defaultConfig(),
              ...(source === "setting" ? { homePath: directory } : {}),
            },
          });
          expect(instance.auth?.credentialBinding).toEqual({
            owner: "provider",
            key: `claude:${yield* fs.realPath(configDirectory)}`,
          });
          expect((yield* instance.snapshot.getSnapshot).setup).toEqual({
            canAuthenticate: false,
            canInstall: false,
          });
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
          Effect.scoped,
        ),
    );
  }
});
