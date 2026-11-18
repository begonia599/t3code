import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      launchers: Schema.Array(Schema.Struct({ launcher: Schema.String, target: Schema.String })),
    }),
  ),
  { onExcessProperty: "error" },
);

const readLauncherTarget = Effect.fn("readLauncherTarget")(function* (
  manifestPath: string,
  resolvedCommandPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // stat follows symlinks. Reject links and special files before open could block on a FIFO.
  const link = yield* fs.readLink(manifestPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag !== "NotFound",
      () => Effect.succeed(null),
    ),
  );
  if (link !== null || (yield* fs.stat(manifestPath)).type !== "File") {
    return yield* Effect.fail("expected a regular file");
  }

  // Check ownership and read through the same descriptor, including across atomic replacements.
  const file = yield* fs.open(manifestPath);
  const info = yield* file.stat;
  const uid = yield* HostProcessUserId;
  const owner = Option.getOrUndefined(info.uid);
  if (
    info.type !== "File" ||
    (info.mode & 0o022) !== 0 ||
    (uid !== undefined && owner !== 0 && owner !== uid)
  ) {
    return yield* Effect.fail("unsafe file type, permissions or owner");
  }
  const { text, invalidUtf8 } = yield* collectUint8StreamText({
    stream: Stream.fromEffectRepeat(file.readAlloc(64 * 1024)).pipe(
      Stream.takeWhile(Option.isSome),
      Stream.map((chunk) => chunk.value),
    ),
  });
  if (invalidUtf8) return yield* Effect.fail("invalid UTF-8");
  const manifest = yield* decodeManifest(text).pipe(
    Effect.mapError(() => "invalid manifest format"),
  );
  const path = yield* Path.Path;
  const targets = new Map<string, string>();
  for (const { launcher, target } of manifest.launchers) {
    if (!path.isAbsolute(launcher) || !path.isAbsolute(target)) {
      return yield* Effect.fail("launcher and target must be absolute paths");
    }
    const key = path.resolve(launcher);
    if (targets.has(key)) return yield* Effect.fail("duplicate launcher path");
    targets.set(key, path.resolve(target));
  }
  return targets.get(path.resolve(resolvedCommandPath)) ?? null;
});

export const resolveProviderLauncherTarget = Effect.fn("resolveProviderLauncherTarget")(function* (
  resolvedCommandPath: string,
) {
  const env = yield* HostProcessEnvironment;
  const manifestPath =
    env.T3CODE_PROVIDER_LAUNCHERS_FILE ??
    ((yield* HostProcessPlatform) === "win32" ? null : "/etc/t3code/provider-launchers.json");
  if (!manifestPath) return null;
  return yield* readLauncherTarget(manifestPath, resolvedCommandPath).pipe(
    Effect.scoped,
    Effect.catch((error) => {
      if (typeof error !== "string" && error.reason._tag === "NotFound")
        return Effect.succeed(null);
      return Effect.logWarning("Ignoring provider launcher manifest", {
        manifestPath,
        reason: typeof error === "string" ? error : error.reason._tag,
      }).pipe(Effect.as(null));
    }),
  );
});
