import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  isProviderPathVisible,
  makeProviderSkillFileSystem,
  makeProviderTemporaryFileSystem,
} from "./ProviderFileAccess.ts";

it.effect(
  "keeps skill discovery and file sharing within the mounted view, including symlinks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-file-view-" });
      const workspace = path.join(base, "project");
      const otherAccount = path.join(base, "project-other-account");
      yield* fs.makeDirectory(workspace);
      yield* fs.makeDirectory(otherAccount);
      const allowed = path.join(workspace, "SKILL.md");
      const privateFile = path.join(otherAccount, "SKILL.md");
      yield* fs.writeFileString(allowed, "allowed skill");
      yield* fs.writeFileString(privateFile, "private account fixture");
      const escape = path.join(workspace, "escape.md");
      yield* fs.symlink(privateFile, escape);
      const roots = [workspace];
      expect(yield* isProviderPathVisible(roots, allowed)).toBe(true);
      expect(yield* isProviderPathVisible(roots, privateFile)).toBe(false);
      expect(yield* isProviderPathVisible(roots, escape)).toBe(false);
      const scoped = yield* makeProviderSkillFileSystem(roots);
      expect(yield* scoped.readFileString(allowed)).toBe("allowed skill");
      expect((yield* scoped.readFileString(escape).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* scoped.readDirectory(otherAccount).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps CLI schemas, outputs and title directories in the instance and cleans them up",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-private-" });
      const scoped = yield* makeProviderTemporaryFileSystem(home);
      const [file, directory] = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* scoped.makeTempFileScoped({ prefix: "schema-" });
          const directory = yield* scoped.makeTempDirectoryScoped({ prefix: "title-" });
          expect(yield* isProviderPathVisible([home], file)).toBe(true);
          expect(yield* isProviderPathVisible([home], directory)).toBe(true);
          yield* scoped.writeFileString(file, "CLI schema");
          expect(yield* scoped.readFileString(file)).toBe("CLI schema");
          expect((yield* fs.stat(path.join(home, ".t3-tmp"))).mode & 0o777).toBe(0o700);
          return [file, directory] as const;
        }),
      );
      expect(yield* fs.exists(file)).toBe(false);
      expect(yield* fs.exists(directory)).toBe(false);
      expect(yield* makeProviderTemporaryFileSystem(undefined)).toBe(fs);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
