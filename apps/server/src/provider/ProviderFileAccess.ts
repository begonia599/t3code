import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

export const isProviderPathVisible = Effect.fn("isProviderPathVisible")(function* (
  roots: ReadonlyArray<string> | undefined,
  filePath: string,
) {
  if (!roots) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* fs.realPath(filePath);
  return roots.some((root) => {
    const relative = path.relative(root, resolved);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  });
});

/** Directory-based Claude discovery must see the same files as its native CLI. */
export const makeProviderSkillFileSystem = Effect.fn("makeProviderSkillFileSystem")(function* (
  roots: ReadonlyArray<string> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!roots) return fs;
  const check = (filePath: string) =>
    isProviderPathVisible(roots, filePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.flatMap((visible) =>
        visible
          ? Effect.void
          : Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "ProviderFileAccess",
                method: "read",
                pathOrDescriptor: filePath,
                description: "This file is outside the provider's mounted view.",
              }),
            ),
      ),
    );
  return {
    ...fs,
    readFileString: (filePath, encoding) =>
      check(filePath).pipe(Effect.andThen(fs.readFileString(filePath, encoding))),
    readDirectory: (filePath, options) =>
      check(filePath).pipe(Effect.andThen(fs.readDirectory(filePath, options))),
  } satisfies FileSystem.FileSystem;
});

/** Files exchanged with a CLI must survive its separate /tmp mount. */
export const makeProviderTemporaryFileSystem = Effect.fn("makeProviderTemporaryFileSystem")(
  function* (providerHome: string | undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!providerHome) return fs;
    const directory = path.join(providerHome, ".t3-tmp");
    const prepare = fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    return {
      ...fs,
      makeTempDirectory: (options) =>
        prepare.pipe(Effect.andThen(fs.makeTempDirectory({ ...options, directory }))),
      makeTempDirectoryScoped: (options) =>
        prepare.pipe(Effect.andThen(fs.makeTempDirectoryScoped({ ...options, directory }))),
      makeTempFile: (options) =>
        prepare.pipe(Effect.andThen(fs.makeTempFile({ ...options, directory }))),
      makeTempFileScoped: (options) =>
        prepare.pipe(Effect.andThen(fs.makeTempFileScoped({ ...options, directory }))),
    } satisfies FileSystem.FileSystem;
  },
);
