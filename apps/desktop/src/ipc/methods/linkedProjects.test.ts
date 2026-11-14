import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { ElectronDialog } from "../../electron/ElectronDialog.ts";
import { DEFAULT_DESKTOP_SETTINGS } from "../../settings/DesktopAppSettings.ts";
import { layerTest } from "../../settings/DesktopAppSettings.ts";
import { pickFolder } from "./linkedProjects.ts";
const windows = ElectronWindow.of({
  create: () => Effect.die("unexpected"),
  main: Effect.succeedNone,
  currentMainOrFirst: Effect.succeedNone,
  focusedMainOrFirst: Effect.succeedNone,
  setMain: () => Effect.void,
  clearMain: () => Effect.void,
  prepareReveal: () => Effect.succeed(false),
  reveal: () => Effect.void,
  sendAll: () => Effect.void,
  destroyAll: Effect.void,
  syncAllAppearance: () => Effect.void,
});

it.effect("Windows linked folder picker works with the local backend disabled", () =>
  Effect.gen(function* () {
    const pick = vi.fn(() => Effect.succeed(Option.some("C:\\work")));
    const result = yield* pickFolder.handler(undefined).pipe(
      Effect.provideService(DesktopEnvironment, {
        platform: "win32",
      } as DesktopEnvironment["Service"]),
      Effect.provide(layerTest({ ...DEFAULT_DESKTOP_SETTINGS, localEnvironmentEnabled: false })),
      Effect.provideService(ElectronWindow, windows),
      Effect.provideService(
        ElectronDialog,
        ElectronDialog.of({
          pickFolder: pick,
          pickFiles: () => Effect.die("unexpected"),
          showMessageBox: () => Effect.die("unexpected"),
          showErrorBox: () => Effect.void,
        }),
      ),
    );
    expect(result).toBe("C:\\work");
    expect(pick).toHaveBeenCalledWith({ owner: Option.none(), defaultPath: Option.none() });
  }),
);
it.effect("non-Windows picker returns null without opening a dialog", () =>
  Effect.gen(function* () {
    const result = yield* pickFolder.handler(undefined).pipe(
      Effect.provideService(DesktopEnvironment, {
        platform: "linux",
      } as DesktopEnvironment["Service"]),
      Effect.provideService(ElectronWindow, windows),
      Effect.provideService(
        ElectronDialog,
        ElectronDialog.of({
          pickFolder: () => Effect.die("unexpected picker"),
          pickFiles: () => Effect.die("unexpected"),
          showMessageBox: () => Effect.die("unexpected"),
          showErrorBox: () => Effect.void,
        }),
      ),
    );
    expect(result).toBeNull();
  }),
);
