import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type NativeConfigTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NativeConfig from "./NativeConfig.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";

const instanceId = ProviderInstanceId.make("editor-test");
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-config-test-" });
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.makeDirectory(cwd, { recursive: true });
  return { fs, path, root, home, cwd, target: { instanceId, cwd } satisfies NativeConfigTarget };
});
function serviceLayer(home: string, driver = "codex", extra: Record<string, unknown> = {}) {
  return NativeConfig.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make(driver),
            config: {
              homePath: home,
              ...(driver === "codex" ? { setupMode: "existing" } : {}),
              ...extra,
            },
          },
        },
      }),
    ),
  );
}
const environment = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-native-config-state-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(environment)("NativeConfig", (it) => {
  for (const driver of ["codex", "claudeAgent"] as const) {
    it.effect(`edits the default ${driver} instance without an explicit instance record`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const target = { instanceId: ProviderInstanceId.make(driver) };
        const filePath = f.path.join(f.home, driver === "codex" ? "config.toml" : "settings.json");
        const before = driver === "codex" ? 'model_verbosity = "medium"\n' : '{"env":{}}\n';
        const after =
          driver === "codex"
            ? 'model_verbosity = "high"\n'
            : '{"env":{"BASH_DEFAULT_TIMEOUT_MS":"60000"}}\n';
        yield* f.fs.writeFileString(filePath, before);
        yield* Effect.gen(function* () {
          const service = yield* NativeConfig.NativeConfig;
          const catalog = yield* service.list(target);
          assert.equal(catalog.driver, driver);
          assert.equal(catalog.homePath, f.home);
          const document = yield* service.read({ ...target, path: filePath });
          const saved = yield* service.write({
            ...target,
            path: filePath,
            revision: document.revision,
            content: after,
          });
          assert.equal(yield* f.fs.readFileString(filePath), after);
          yield* service.undo({ undoToken: saved.undoToken });
          assert.equal(yield* f.fs.readFileString(filePath), before);
        }).pipe(
          Effect.provide(
            NativeConfig.layer.pipe(
              Layer.provide(
                ServerSettings.layerTest({
                  providerInstances: {},
                  providers: {
                    [driver]: {
                      homePath: f.home,
                      ...(driver === "codex" ? { setupMode: "existing" } : {}),
                    },
                  },
                }),
              ),
            ),
          ),
        );
      }),
    );
  }

  it.effect(
    "keeps explicit instances ahead of legacy defaults and rejects missing custom instances",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const codexId = ProviderInstanceId.make("codex");
        yield* Effect.gen(function* () {
          const service = yield* NativeConfig.NativeConfig;
          assert.equal((yield* service.list({ instanceId: codexId })).homePath, f.home);
          const missing = yield* service.list({ instanceId }).pipe(Effect.result);
          assert.equal(missing._tag, "Failure");
          if (missing._tag === "Failure") assert.equal(missing.failure.reason, "unsupported");
        }).pipe(
          Effect.provide(
            NativeConfig.layer.pipe(
              Layer.provide(
                ServerSettings.layerTest({
                  providers: { codex: { homePath: f.path.join(f.root, "unused-legacy-home") } },
                  providerInstances: {
                    [codexId]: {
                      driver: ProviderDriverKind.make("codex"),
                      config: { homePath: f.home, setupMode: "existing" },
                    },
                  },
                }),
              ),
            ),
          ),
        );
      }),
  );

  it.effect("finds Claude local settings in a linked worktree's main checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const main = f.path.join(f.root, "main");
      const gitDir = f.path.join(main, ".git", "worktrees", "linked");
      const local = f.path.join(main, ".claude", "settings.local.json");
      yield* f.fs.makeDirectory(gitDir, { recursive: true });
      yield* f.fs.makeDirectory(f.path.dirname(local), { recursive: true });
      yield* f.fs.writeFileString(local, "{ /* native comment */ }");
      yield* f.fs.writeFileString(f.path.join(f.cwd, ".git"), `gitdir: ${gitDir}\n`);
      yield* f.fs.writeFileString(f.path.join(gitDir, "commondir"), "../..\n");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        assert.isTrue(
          (yield* service.list(f.target)).files.some(
            (file) => file.path === local && file.scope === "local",
          ),
        );
        const before = yield* service.read({ ...f.target, path: local });
        const saved = yield* service.write({
          ...f.target,
          path: local,
          revision: before.revision,
          content: '{ /* keep */ "env": {}, }',
        });
        assert.equal(saved.document.content, '{ /* keep */ "env": {}, }');
      }).pipe(Effect.provide(serviceLayer(f.home, "claudeAgent")));
    }),
  );
  it.effect("edits shared Codex configuration while keeping shadow memories separate", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const shadow = f.path.join(f.root, "shadow");
      yield* f.fs.makeDirectory(f.path.join(shadow, "memories"), { recursive: true });
      yield* f.fs.writeFileString(f.path.join(shadow, "memories", "memory.md"), "shadow memory");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const catalog = yield* service.list(f.target);
        assert.equal(catalog.homePath, shadow);
        assert.isTrue(
          catalog.files.some((file) => file.path === f.path.join(f.home, "config.toml")),
        );
        assert.isFalse(
          catalog.files.some((file) => file.path === f.path.join(shadow, "config.toml")),
        );
        assert.isTrue(
          catalog.files.some((file) => file.path === f.path.join(shadow, "memories", "memory.md")),
        );
      }).pipe(Effect.provide(serviceLayer(f.home, "codex", { shadowHomePath: shadow })));
    }),
  );

  it.effect("uses instance environment homes and reports names without values", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const nativeLayer = NativeConfig.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: "../home", sensitive: false },
                  { name: "ANTHROPIC_API_KEY", value: "fixture-secret", sensitive: true },
                ],
              },
            },
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const catalog = yield* service.list(f.target);
        assert.equal(catalog.homePath, f.home);
        assert.include(catalog.environmentOverrides, "ANTHROPIC_API_KEY");
        assert.notInclude(catalog.environmentOverrides, "fixture-secret");
      }).pipe(Effect.provide(nativeLayer));
    }),
  );

  it.effect("bounds file reads and preserves a UTF-8 BOM in instructions", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.home, "AGENTS.md");
      yield* f.fs.writeFileString(filePath, "\uFEFF# Instructions");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const read = yield* service.read({ ...f.target, path: filePath });
        assert.equal(read.content, "\uFEFF# Instructions");
        yield* f.fs.writeFileString(filePath, "x".repeat(256 * 1024 + 1));
        assert.equal(
          (yield* service.read({ ...f.target, path: filePath }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* f.fs.writeFile(filePath, new Uint8Array([255, 254, 0, 1]));
        assert.equal(
          (yield* service.read({ ...f.target, path: filePath }).pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(serviceLayer(f.home)));
    }),
  );
  it.effect(
    "discovers actual homes, missing project files, skills and memory without exposing credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const skill = f.path.join(f.home, "skills", "example");
        const memory = f.path.join(f.home, "projects", "native-project-id", "memory");
        yield* f.fs.makeDirectory(skill, { recursive: true });
        yield* f.fs.makeDirectory(memory, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(skill, "SKILL.md"), "# Example");
        yield* f.fs.writeFileString(f.path.join(memory, "MEMORY.md"), "# Memory");
        yield* f.fs.writeFileString(f.path.join(f.home, ".credentials.json"), "not configuration");
        yield* Effect.gen(function* () {
          const service = yield* NativeConfig.NativeConfig;
          const result = yield* service.list(f.target);
          assert.equal(result.homePath, f.home);
          assert.isTrue(result.files.some((file) => file.kind === "skill" && file.exists));
          assert.isTrue(result.files.some((file) => file.kind === "memory" && file.exists));
          assert.isTrue(
            result.files.some(
              (file) =>
                file.path === f.path.join(f.cwd, ".claude", "settings.local.json") && !file.exists,
            ),
          );
          assert.isFalse(result.files.some((file) => file.path.endsWith(".credentials.json")));
          const refused = yield* service
            .read({ ...f.target, path: f.path.join(f.home, ".credentials.json") })
            .pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
        }).pipe(Effect.provide(serviceLayer(f.home, "claudeAgent")));
      }),
  );

  it.effect(
    "previews without writing, saves atomically through a symlink, preserves mode and undoes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const real = f.path.join(f.root, "real.toml");
        const filePath = f.path.join(f.home, "config.toml");
        const original = '# comment\nmodel = "old"\n';
        yield* f.fs.writeFileString(real, original);
        yield* f.fs.chmod(real, 0o640);
        yield* f.fs.symlink(real, filePath);
        yield* Effect.gen(function* () {
          const service = yield* NativeConfig.NativeConfig;
          const before = yield* service.read({ ...f.target, path: filePath });
          assert.equal(before.resolvedPath, real);
          const input = {
            ...f.target,
            path: filePath,
            revision: before.revision,
            content: '# comment\nmodel = "new"\n',
          };
          assert.include(yield* service.preview(input), '+model = "new"');
          assert.equal(yield* f.fs.readFileString(real), original);
          const saved = yield* service.write(input);
          assert.equal(yield* f.fs.readLink(filePath), real);
          assert.equal((yield* f.fs.stat(real)).mode & 0o777, 0o640);
          assert.equal(yield* f.fs.readFileString(real), input.content);
          const restored = yield* service.undo({ undoToken: saved.undoToken });
          assert.equal(restored.content, original);
        }).pipe(Effect.provide(serviceLayer(f.home)));
      }),
  );

  it.effect("rejects invalid syntax, stale saves and undo after an external write", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.home, "settings.json");
      yield* f.fs.writeFileString(filePath, "{}");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const before = yield* service.read({ ...f.target, path: filePath });
        const invalid = yield* service
          .write({ ...f.target, path: filePath, revision: before.revision, content: "{" })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(yield* f.fs.readFileString(filePath), "{}");
        const saved = yield* service.write({
          ...f.target,
          path: filePath,
          revision: before.revision,
          content: '{"unknown":42}',
        });
        const stale = yield* service
          .write({ ...f.target, path: filePath, revision: before.revision, content: "{}" })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.equal(stale.failure.reason, "conflict");
        yield* f.fs.writeFileString(filePath, '{"external":true}');
        const undo = yield* service.undo({ undoToken: saved.undoToken }).pipe(Effect.result);
        assert.equal(undo._tag, "Failure");
        if (undo._tag === "Failure") assert.equal(undo.failure.reason, "conflict");
        assert.equal(yield* f.fs.readFileString(filePath), '{"external":true}');
      }).pipe(Effect.provide(serviceLayer(f.home, "claudeAgent")));
    }),
  );

  it.effect("creates a missing file and undo restores absence", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.cwd, ".codex", "config.toml");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const before = yield* service.read({ ...f.target, path: filePath });
        assert.isFalse(before.file.exists);
        const saved = yield* service.write({
          ...f.target,
          path: filePath,
          revision: before.revision,
          content: 'model_verbosity = "high"\n',
        });
        assert.isTrue(saved.document.file.exists);
        const undone = yield* service.undo({ undoToken: saved.undoToken });
        assert.isFalse(undone.file.exists);
        assert.isFalse(yield* f.fs.exists(filePath));
      }).pipe(Effect.provide(serviceLayer(f.home)));
    }),
  );

  it.effect("serializes concurrent saves so only one revision wins", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.home, "config.toml");
      yield* f.fs.writeFileString(filePath, "# initial\n");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const before = yield* service.read({ ...f.target, path: filePath });
        const results = yield* Effect.forEach(
          ["first", "second"],
          (value) =>
            service
              .write({
                ...f.target,
                path: filePath,
                revision: before.revision,
                content: `model = "${value}"\n`,
              })
              .pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(
          results.filter(
            (result) => result._tag === "Failure" && result.failure.reason === "conflict",
          ).length,
          1,
        );
        assert.isFalse((yield* f.fs.readDirectory(f.home)).some((name) => name.endsWith(".tmp")));
      }).pipe(Effect.provide(serviceLayer(f.home)));
    }),
  );

  it.effect("creates and undoes a dangling link's target without replacing the link", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.home, "config.toml");
      const target = f.path.join(f.root, "shared", "config.toml");
      yield* f.fs.symlink(target, filePath);
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const before = yield* service.read({ ...f.target, path: filePath });
        assert.equal(before.resolvedPath, target);
        assert.isFalse(before.file.exists);
        const saved = yield* service.write({
          ...f.target,
          path: filePath,
          revision: before.revision,
          content: "# shared settings\n",
        });
        assert.equal(yield* f.fs.readFileString(target), saved.document.content);
        assert.equal(yield* f.fs.readLink(filePath), target);
        yield* service.undo({ undoToken: saved.undoToken });
        assert.isFalse(yield* f.fs.exists(target));
        assert.equal(yield* f.fs.readLink(filePath), target);
        yield* f.fs.chmod(f.path.dirname(target), 0o555);
        yield* Effect.gen(function* () {
          assert.isFalse((yield* service.read({ ...f.target, path: filePath })).file.writable);
        }).pipe(Effect.ensuring(f.fs.chmod(f.path.dirname(target), 0o755).pipe(Effect.orDie)));
      }).pipe(Effect.provide(serviceLayer(f.home)));
    }),
  );

  it.effect("rejects symlink retargeting and read-only files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.home, "config.toml");
      const one = f.path.join(f.root, "one.toml");
      const two = f.path.join(f.root, "two.toml");
      yield* f.fs.writeFileString(one, "# one");
      yield* f.fs.writeFileString(two, "# two");
      yield* f.fs.symlink(one, filePath);
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const before = yield* service.read({ ...f.target, path: filePath });
        yield* f.fs.remove(filePath);
        yield* f.fs.symlink(two, filePath);
        const result = yield* service
          .write({
            ...f.target,
            path: filePath,
            revision: before.revision,
            content: "# replacement",
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "conflict");
        assert.equal(yield* f.fs.readFileString(two), "# two");
        yield* f.fs.chmod(two, 0o444);
        const readonly = yield* service.read({ ...f.target, path: filePath });
        assert.isFalse(readonly.file.writable);
      }).pipe(Effect.provide(serviceLayer(f.home)));
    }),
  );

  it.effect("repairs invalid JSON while undo preserves the exact prior bytes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filePath = f.path.join(f.home, "settings.json");
      yield* f.fs.writeFileString(filePath, "{ broken");
      yield* Effect.gen(function* () {
        const service = yield* NativeConfig.NativeConfig;
        const before = yield* service.read({ ...f.target, path: filePath });
        const saved = yield* service.write({
          ...f.target,
          path: filePath,
          revision: before.revision,
          content: "{}\n",
        });
        assert.equal((yield* service.undo({ undoToken: saved.undoToken })).content, "{ broken");
      }).pipe(Effect.provide(serviceLayer(f.home, "claudeAgent")));
    }),
  );
});
