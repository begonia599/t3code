import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as DesktopLink from "./DesktopLinkService.ts";
import * as Broker from "../desktopChannel/DesktopChannelBroker.ts";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const hostId = "91d581f4-d87a-4efe-967c-2b60314575bb";
const sessionId = AuthSessionId.make("desktop");
const caller = { sessionId };

it("normalizes separators and trailing separators without changing case", () => {
  assert.equal(DesktopLink.normalizeWinPath("D:/工作/Project/"), "D:\\工作\\Project");
  assert.equal(DesktopLink.normalizeWinPath("\\\\PC\\Share\\Project\\"), "\\\\PC\\Share\\Project");
});
for (const path of [
  "C:\\",
  "\\\\pc\\share",
  "\\\\pc\\share\\",
  "C:\\a\\..\\b",
  "C:\\a\\.\\b",
  "relative",
  "C:folder",
  "C:\\bad?",
  ...["<", ">", '"', "|", "*", "\u0000"].map((character) => `C:\\bad${character}`),
  "C:\\bad:stream",
  "C:\\bad\n",
  `C:\\${"x".repeat(258)}`,
]) {
  it(`rejects invalid Windows path ${JSON.stringify(path)}`, () => {
    assert.throws(() => DesktopLink.normalizeWinPath(path), /Windows folder/);
  });
}
it("keeps Unicode in slugs, falls back and truncates", () => {
  assert.equal(DesktopLink.desktopLinkSlug("..- 我的 电脑!?"), "我的-电脑");
  assert.equal(DesktopLink.desktopLinkSlug("?!"), "project");
  assert.equal(DesktopLink.desktopLinkSlug("..", "host1234"), "host1234");
  assert.equal(DesktopLink.desktopLinkSlug("中".repeat(100)), "中".repeat(64));
});

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "m5b-links-" });
  const config = yield* Config.ServerConfig;
  let rejectSettingsUpdates = false;
  const settingsLayer = Layer.effect(
    Settings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      return Settings.ServerSettingsService.of({
        ...settings,
        updateSettings: (patch) =>
          rejectSettingsUpdates
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "/test/settings.json",
                  operation: "write-file",
                  cause: "injected cleanup failure",
                }),
              )
            : settings.updateSettings(patch),
      });
    }),
  ).pipe(Layer.provide(Settings.layerTest()));
  const context = yield* Layer.build(
    DesktopLink.layer.pipe(
      Layer.provideMerge(OrchestrationLayerLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(Broker.layer),
      Layer.provideMerge(settingsLayer),
      Layer.provide(Git.vcsLayer.pipe(Layer.provide(VcsProcess.layer))),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(Layer.succeed(Config.ServerConfig, { ...config, winProjectsRoot: root })),
    ),
  );
  const service = Context.get(context, DesktopLink.DesktopLinkService);
  const query = Context.get(context, ProjectionSnapshotQuery);
  const engine = Context.get(context, OrchestrationEngineService);
  const settings = Context.get(context, Settings.ServerSettingsService);
  const sql = Context.get(context, SqlClient.SqlClient);
  const broker = Context.get(context, Broker.DesktopChannelBroker);
  const startHost = Effect.fn(function* (
    platform: "win32" | "linux" = "win32",
    authSession = sessionId,
    hostName = "Windows PC",
  ) {
    const ready = yield* Deferred.make<void>();
    const stream = yield* broker.connect(
      {
        hostId,
        hostName,
        platform,
        appVersion: "1",
        environmentId: EnvironmentId.make("env"),
        capabilities: { enabled: true },
      },
      { subject: "owner", sessionId: authSession },
    );
    yield* Stream.runForEach(stream, (event) =>
      event.type === "connected" ? Deferred.succeed(ready, undefined) : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
  });
  const create = (winPath = "C:\\Projects\\Demo") =>
    service.createProject({ hostId, winPath }, caller);
  return {
    service,
    query,
    engine,
    settings,
    sql,
    root,
    fs,
    startHost,
    create,
    failSettingsUpdates: () => {
      rejectSettingsUpdates = true;
    },
  };
});
const testLayer = Config.layerTest("/tmp", { prefix: "m5b-config-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(testLayer)("DesktopLinkService", (it) => {
  it.effect("creates a git workspace, settings and registry, and is idempotent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        assert.isTrue(link.created);
        assert.isTrue(yield* f.fs.exists(`${link.serverPath}/.git`));
        assert.equal(
          (yield* f.query.getProjectShellById(link.projectId)).pipe(Option.getOrThrow)
            .workspaceRoot,
          link.serverPath,
        );
        assert.isTrue(
          (yield* f.settings.getSettings).projectSettingsOverrides[link.projectId]
            ?.enableAgentWinAccess,
        );
        assert.equal((yield* f.sql`SELECT * FROM desktop_linked_projects`).length, 1);
        assert.deepEqual(yield* f.create("c:/projects/demo/"), { ...link, created: false });
        assert.equal((yield* f.query.getProjectShells()).length, 1);
        const second = yield* f.create("D:\\Other\\Demo");
        assert.equal(second.serverPath, `${link.serverPath}-2`);
      }),
    ),
  );
  it.effect("serializes concurrent creates for the same Windows folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const results = yield* Effect.all([f.create(), f.create()], { concurrency: "unbounded" });
        assert.equal(results.filter((link) => link.created).length, 1);
        assert.equal(results[0]?.projectId, results[1]?.projectId);
        assert.equal((yield* f.sql`SELECT * FROM desktop_linked_projects`).length, 1);
      }),
    ),
  );
  it.effect(
    "skips existing directories and active project paths even if the directory is absent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.startHost();
          const first = `${f.root}/Windows-PC/Demo`;
          yield* f.fs.makeDirectory(first, { recursive: true });
          yield* f.fs.writeFileString(`${first}/keep`, "existing");
          yield* f.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("reserve"),
            projectId: ProjectId.make("reserved"),
            title: "Reserved",
            workspaceRoot: `${first}-2`,
            createdAt: "2026-01-01",
          });
          const link = yield* f.create();
          assert.equal(link.serverPath, `${first}-3`);
          assert.equal(yield* f.fs.readFileString(`${first}/keep`), "existing");
        }),
      ),
  );
  it.effect("deletes linked projects containing threads through the existing force command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        const threadId = ThreadId.make("linked-thread");
        yield* f.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-thread"),
          projectId: link.projectId,
          threadId,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01",
        });
        yield* f.service.unlink({ projectId: link.projectId, deleteServerCopy: true });
        assert.isTrue(Option.isNone(yield* f.query.getThreadShellById(threadId)));
        assert.isFalse(yield* f.fs.exists(link.serverPath));
      }),
    ),
  );
  for (const mode of ["missing", "linux", "session"] as const) {
    it.effect(`rejects ${mode} host`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          if (mode !== "missing")
            yield* f.startHost(
              mode === "linux" ? "linux" : "win32",
              mode === "session" ? AuthSessionId.make("other") : sessionId,
            );
          const error = yield* f.create().pipe(Effect.flip);
          assert.equal(
            error.code,
            mode === "missing"
              ? "HOST_NOT_CONNECTED"
              : mode === "linux"
                ? "HOST_NOT_WINDOWS"
                : "HOST_SESSION_MISMATCH",
          );
        }),
      ),
    );
  }
  it.effect("rolls back the project, directory and override after a registry failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        yield* f.sql`CREATE TRIGGER reject_link BEFORE INSERT ON desktop_linked_projects BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
        assert.equal((yield* f.create().pipe(Effect.flip)).code, "CREATE_FAILED");
        assert.equal((yield* f.query.getProjectShells()).length, 0);
        assert.isFalse(yield* f.fs.exists(`${f.root}/Windows-PC/Demo`));
        assert.deepEqual((yield* f.settings.getSettings).projectSettingsOverrides, {});
        assert.equal((yield* f.sql`SELECT * FROM desktop_linked_projects`).length, 0);
      }),
    ),
  );
  it.effect("filters deleted projects and permits recreating a stale association", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const old = yield* f.create();
        yield* f.engine.dispatch({
          type: "project.delete",
          projectId: old.projectId,
          commandId: CommandId.make("delete-old"),
        });
        assert.isTrue(Option.isNone(yield* f.service.getLinkForProject(old.projectId)));
        const fresh = yield* f.create();
        assert.notEqual(fresh.projectId, old.projectId);
        yield* f.engine.dispatch({
          type: "project.delete",
          projectId: fresh.projectId,
          commandId: CommandId.make("delete-new"),
        });
        assert.deepEqual(yield* f.service.list(), []);
      }),
    ),
  );
  for (const deleteServerCopy of [false, true]) {
    it.effect(`unlinks with deleteServerCopy=${deleteServerCopy}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.startHost();
          const link = yield* f.create();
          assert.deepEqual(
            yield* f.service.unlink({ projectId: link.projectId, deleteServerCopy }),
            { projectId: link.projectId, serverCopyDeleted: deleteServerCopy },
          );
          assert.equal(yield* f.fs.exists(link.serverPath), !deleteServerCopy);
          assert.equal(
            Option.isSome(yield* f.query.getProjectShellById(link.projectId)),
            !deleteServerCopy,
          );
          assert.deepEqual(yield* f.service.list(), []);
          assert.isUndefined(
            (yield* f.settings.getSettings).projectSettingsOverrides[link.projectId],
          );
          assert.equal(
            (yield* f.service
              .unlink({ projectId: link.projectId, deleteServerCopy })
              .pipe(Effect.flip)).code,
            "NOT_LINKED",
          );
        }),
      ),
    );
  }
  it.effect("unlinks and deletes the project when its server directory was already removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        yield* f.fs.remove(link.serverPath, { recursive: true });
        assert.deepEqual(
          yield* f.service.unlink({ projectId: link.projectId, deleteServerCopy: true }),
          { projectId: link.projectId, serverCopyDeleted: true },
        );
        assert.isTrue(Option.isNone(yield* f.query.getProjectShellById(link.projectId)));
        assert.deepEqual(yield* f.service.list(), []);
        assert.isUndefined(
          (yield* f.settings.getSettings).projectSettingsOverrides[link.projectId],
        );
      }),
    ),
  );
  for (const deleteServerCopy of [false, true]) {
    it.effect(
      `cleans up only the appropriate project settings on unlink (${deleteServerCopy})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.startHost();
            const link = yield* f.create();
            yield* f.settings.updateSettings({
              projectSettingsOverrides: {
                [link.projectId]: {
                  enableAgentWinAccess: true,
                  enableAgentBrowserAccess: false,
                  defaultRuntimeMode: "full-access",
                },
              },
            });
            yield* f.service.unlink({ projectId: link.projectId, deleteServerCopy });
            assert.deepEqual(
              (yield* f.settings.getSettings).projectSettingsOverrides[link.projectId],
              deleteServerCopy
                ? undefined
                : { enableAgentBrowserAccess: false, defaultRuntimeMode: "full-access" },
            );
          }),
        ),
    );
    it.effect(`completes unlink when settings cleanup fails (${deleteServerCopy})`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.startHost();
          const link = yield* f.create();
          f.failSettingsUpdates();
          assert.deepEqual(
            yield* f.service.unlink({ projectId: link.projectId, deleteServerCopy }),
            { projectId: link.projectId, serverCopyDeleted: deleteServerCopy },
          );
          assert.equal(
            Option.isSome(yield* f.query.getProjectShellById(link.projectId)),
            !deleteServerCopy,
          );
          assert.deepEqual(yield* f.service.list(), []);
        }),
      ),
    );
  }
  it.effect("resolves conflicts by deleting only the server file or directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        yield* f.fs.makeDirectory(`${link.serverPath}/src/tree`, { recursive: true });
        yield* f.fs.writeFileString(`${link.serverPath}/src/a.py`, "server copy");
        yield* f.fs.writeFileString(`${link.serverPath}/src/keep.py`, "keep");
        yield* f.fs.writeFileString(`${link.serverPath}/src/tree/a.py`, "nested");
        for (const path of ["src/a.py", "src/tree"]) {
          assert.deepEqual(yield* f.service.resolveConflict({ projectId: link.projectId, path }), {
            projectId: link.projectId,
            path,
            removed: true,
          });
          assert.isFalse(yield* f.fs.exists(`${link.serverPath}/${path}`));
        }
        assert.equal(yield* f.fs.readFileString(`${link.serverPath}/src/keep.py`), "keep");
        for (const path of ["src/missing.py", "missing/parent/file.py"])
          assert.deepEqual(yield* f.service.resolveConflict({ projectId: link.projectId, path }), {
            projectId: link.projectId,
            path,
            removed: false,
          });
        assert.isTrue(yield* f.fs.exists(`${link.serverPath}/.git`));
      }),
    ),
  );
  it.effect("rejects invalid conflict paths and symlink parents without deleting anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "m5b-conflict-outside-" });
        yield* f.fs.writeFileString(`${outside}/keep`, "outside");
        yield* f.fs.symlink(outside, `${link.serverPath}/escape`);
        yield* f.fs.symlink(`${link.serverPath}/.git`, `${link.serverPath}/history`);
        for (const path of [
          "",
          "../x",
          "/etc/passwd",
          "C:\\x",
          "C:x",
          "\\\\pc\\share\\x",
          "a/../../x",
          "a/./x",
          "a/../x",
          "a\\..\\x",
          "a//x",
          "nul\0x",
          ".git",
          ".git/config",
          ".GIT/config",
          "escape/keep",
          "escape/missing/file",
          "history/missing/file",
          "history/config",
        ]) {
          assert.equal(
            (yield* f.service
              .resolveConflict({ projectId: link.projectId, path })
              .pipe(Effect.flip)).code,
            "INVALID_CONFLICT_PATH",
            path,
          );
        }
        assert.equal(yield* f.fs.readFileString(`${outside}/keep`), "outside");
        assert.isTrue(yield* f.fs.exists(`${link.serverPath}/.git/config`));
      }),
    ),
  );
  it.effect("removes symlinks themselves, including dangling links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "m5b-conflict-link-" });
        yield* f.fs.writeFileString(`${outside}/keep`, "outside");
        yield* f.fs.symlink(outside, `${link.serverPath}/directory-link`);
        yield* f.fs.symlink(`${outside}/keep`, `${link.serverPath}/file-link`);
        yield* f.fs.symlink(`${outside}/missing`, `${link.serverPath}/dangling-link`);
        for (const path of ["directory-link", "file-link", "dangling-link"]) {
          assert.isTrue(
            (yield* f.service.resolveConflict({ projectId: link.projectId, path })).removed,
          );
          assert.equal(
            (yield* f.fs.readLink(`${link.serverPath}/${path}`).pipe(Effect.result))._tag,
            "Failure",
          );
        }
        assert.equal(yield* f.fs.readFileString(`${outside}/keep`), "outside");
      }),
    ),
  );
  it.effect("rejects conflict resolution for an unlinked project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        yield* f.service.unlink({ projectId: link.projectId, deleteServerCopy: false });
        assert.equal(
          (yield* f.service
            .resolveConflict({ projectId: link.projectId, path: "file" })
            .pipe(Effect.flip)).code,
          "NOT_LINKED",
        );
      }),
    ),
  );
  it.effect(
    "refuses outside paths, the root itself and symlinks escaping the root before deleting anything",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.startHost();
          const link = yield* f.create();
          const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "m5b-outside-" });
          const symlink = `${f.root}/escape`;
          yield* f.fs.symlink(outside, symlink);
          for (const unsafe of [outside, f.root, symlink]) {
            yield* f.sql`UPDATE desktop_linked_projects SET server_path=${unsafe} WHERE project_id=${link.projectId}`;
            assert.equal(
              (yield* f.service
                .unlink({ projectId: link.projectId, deleteServerCopy: true })
                .pipe(Effect.flip)).code,
              "UNSAFE_PATH",
            );
            assert.isTrue(yield* f.fs.exists(unsafe));
            assert.isTrue(Option.isSome(yield* f.query.getProjectShellById(link.projectId)));
            assert.equal((yield* f.sql`SELECT * FROM desktop_linked_projects`).length, 1);
          }
        }),
      ),
  );
  it.effect("updates connected host name snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.startHost();
        const link = yield* f.create();
        yield* f.startHost("win32", sessionId, "Renamed PC");
        assert.equal((yield* f.service.list())[0]?.hostName, "Renamed PC");
        assert.equal(
          (yield* f.service.getLinkForProject(link.projectId)).pipe(Option.getOrThrow).hostName,
          "Renamed PC",
        );
      }),
    ),
  );
});
