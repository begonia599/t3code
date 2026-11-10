// @effect-diagnostics nodeBuiltinImport:off -- Electron resource and userData paths are native boundaries.
import { SyncEnvironment } from "./SyncEnvironment.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { DesktopConnectionCatalogStore } from "../app/DesktopConnectionCatalogStore.ts";
import { findSyncPaths, startDaemon } from "./daemon.ts";
import { resolveCatalogTarget } from "./catalog.ts";
import { startRelay } from "./relay.ts";
import { syncHost } from "./protocol.ts";

export const layer = Layer.effect(
  SyncEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const catalog = yield* DesktopConnectionCatalogStore;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const disabled = { environment: async () => ({}) };
    const paths = yield* Effect.promise(() =>
      findSyncPaths({
        resourcesPath: environment.resourcesPath,
        userData: Electron.app.getPath("userData"),
        platform: environment.platform,
      }),
    );
    if (!paths) return disabled;
    const readCatalog = async () => Option.getOrUndefined(await run(catalog.get));
    const resolve = async (host: string) => resolveCatalogTarget(await readCatalog(), host);
    const relay = yield* Effect.tryPromise(() => startRelay(resolve)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (!relay) return disabled;
    yield* Effect.addFinalizer(() => Effect.promise(() => relay.stop()));
    const daemon = yield* Effect.tryPromise(() => startDaemon(paths, relay)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (!daemon) {
      yield* Effect.promise(() => relay.stop());
      return disabled;
    }
    yield* Effect.addFinalizer(() => Effect.promise(() => daemon.stop().catch(() => {})));
    return {
      environment: async (environmentId: string) => {
        if (!daemon.running) return {};
        const host = syncHost(environmentId);
        try {
          await resolve(host);
        } catch {
          return {};
        }
        return {
          T3_MUTAGEN_EXE: paths.executable,
          T3_MUTAGEN_DATA_DIRECTORY: paths.dataDirectory,
          T3_SYNC_HOST: host,
        };
      },
    };
  }),
);
