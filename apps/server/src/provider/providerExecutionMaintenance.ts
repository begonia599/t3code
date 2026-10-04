import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { makeProviderExecution } from "./ProviderExecution.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "./providerMaintenance.ts";

/** Keep maintenance commands inside the instance boundary that owns their installation. */
export const resolveProviderExecutionMaintenance = Effect.fn("resolveProviderExecutionMaintenance")(
  function* (
    runtime: Effect.Success<ReturnType<typeof makeProviderExecution>>,
    input: {
      readonly provider: ProviderDriverKind;
      readonly packageName: string;
      readonly resolver: ProviderMaintenanceCapabilitiesResolver;
      readonly binaryPath: string;
      readonly environment: NodeJS.ProcessEnv;
    },
  ) {
    const description = runtime.description;
    if (description) {
      const manual = makeManualOnlyProviderMaintenanceCapabilities(input);
      if (!description.softwareDirectory) return manual;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realPath = yield* fs.realPath(input.binaryPath).pipe(Effect.orElseSucceed(() => null));
      if (!realPath) return manual;
      const relative = path.relative(description.softwareDirectory, realPath);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        return manual;
    }
    const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(input.resolver, {
      binaryPath: input.binaryPath,
      env: input.environment,
    });
    if (!description || !capabilities.update) return capabilities;
    return {
      ...capabilities,
      update: {
        ...capabilities.update,
        env: { ...input.environment, ...capabilities.update.env },
        spawner: runtime.spawner,
      },
    };
  },
);
