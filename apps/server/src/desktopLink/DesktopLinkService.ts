import {
  CommandId,
  DesktopLinkedProject,
  DesktopLinkError,
  ProjectId,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as DesktopChannelBroker from "../desktopChannel/DesktopChannelBroker.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";

const isDesktopLinkError = Schema.is(DesktopLinkError);

/** Normalize without resolving dot segments or changing the user's path casing. */
export function normalizeWinPath(input: string): string {
  const normalized = input.replaceAll("/", "\\");
  const invalid = () =>
    new DesktopLinkError({
      code: "INVALID_WIN_PATH",
      message:
        "Select a Windows folder below a drive or network share root (maximum 260 characters).",
    });
  // oxlint-disable-next-line no-control-regex -- Windows paths cannot contain control characters.
  if (normalized.length > 260 || /[\x00-\x1f\x7f-\x9f<>"|?*]/u.test(normalized)) throw invalid();
  const drive = /^[a-z]:\\/i.test(normalized);
  const unc = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized);
  if (!drive && !unc) throw invalid();
  if ((drive ? normalized.slice(2) : normalized).includes(":")) throw invalid();
  const path = normalized.replace(/\\+$/, "");
  const segments = (drive ? path.slice(3) : path.slice(2)).split("\\");
  if (segments.some((s) => s === "." || s === ".." || s === "")) throw invalid();
  if ((drive && path.length <= 2) || (unc && segments.length <= 2)) throw invalid();
  return path;
}

/** Filesystem-safe names retain readable Unicode; fallbacks are supplied by the caller. */
export const desktopLinkSlug = (input: string, fallback = "project"): string =>
  Array.from(
    input
      .replace(/\s+/gu, "-")
      .replace(/[^\p{L}\p{N}._-]/gu, "")
      .replace(/^[.-]+/u, ""),
  )
    .slice(0, 64)
    .join("") || fallback;

export class DesktopLinkService extends Context.Service<
  DesktopLinkService,
  {
    readonly createProject: (
      input: { hostId: string; winPath: string },
      caller: { sessionId: AuthSessionId },
    ) => Effect.Effect<DesktopLinkedProject & { created: boolean }, DesktopLinkError>;
    readonly list: () => Effect.Effect<ReadonlyArray<DesktopLinkedProject>, DesktopLinkError>;
    readonly unlink: (input: {
      projectId: ProjectId;
      deleteServerCopy: boolean;
    }) => Effect.Effect<{ projectId: ProjectId; serverCopyDeleted: boolean }, DesktopLinkError>;
    readonly resolveConflict: (input: {
      projectId: ProjectId;
      path: string;
    }) => Effect.Effect<{ projectId: ProjectId; path: string; removed: boolean }, DesktopLinkError>;
    readonly getLinkForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<DesktopLinkedProject>, DesktopLinkError>;
  }
>()("t3/desktopLink/DesktopLinkService") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const broker = yield* DesktopChannelBroker.DesktopChannelBroker;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* VcsDriver.VcsDriver;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const root = path.resolve(config.winProjectsRoot ?? expandHomePathWith("~/win-projects", path));
  const semaphore = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const failure = (cause: unknown) =>
    new DesktopLinkError({
      code: "CREATE_FAILED",
      message: `Desktop project operation failed: ${String(cause)}`,
    });
  const rows = () =>
    sql`SELECT project_id AS "projectId", host_id AS "hostId", host_name AS "hostName", win_path AS "winPath", server_path AS "serverPath", created_at AS "createdAt" FROM desktop_linked_projects`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DesktopLinkedProject))),
    );
  const removeRow = (projectId: ProjectId) =>
    sql`DELETE FROM desktop_linked_projects WHERE project_id=${projectId}`;
  const deleteProject = Effect.fn("DesktopLinkService.deleteProject")(function* (
    projectId: ProjectId,
    expectedWorkspaceRoot?: string,
  ) {
    const project = yield* query.getProjectShellById(projectId);
    if (
      Option.isSome(project) &&
      (expectedWorkspaceRoot === undefined || project.value.workspaceRoot === expectedWorkspaceRoot)
    ) {
      yield* engine.dispatch({
        type: "project.delete",
        projectId,
        force: true,
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
      });
    }
  });
  const getLinkForProject: DesktopLinkService["Service"]["getLinkForProject"] = Effect.fn(
    "DesktopLinkService.getLinkForProject",
  )(function* (projectId) {
    if (Option.isNone(yield* query.getProjectShellById(projectId))) return Option.none();
    // A project lookup uses its primary key rather than scanning every link on every win invocation.
    const result =
      yield* sql`SELECT project_id AS "projectId", host_id AS "hostId", host_name AS "hostName", win_path AS "winPath", server_path AS "serverPath", created_at AS "createdAt" FROM desktop_linked_projects WHERE project_id=${projectId}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DesktopLinkedProject))),
      );
    return Option.fromUndefinedOr(result[0]);
  }, Effect.mapError(failure));
  const createProject: DesktopLinkService["Service"]["createProject"] = Effect.fn(
    "DesktopLinkService.createProject",
  )(
    function* (input, caller) {
      const host = (yield* broker.listHosts()).find((h) => h.hostId === input.hostId);
      if (!host)
        return yield* new DesktopLinkError({
          code: "HOST_NOT_CONNECTED",
          message: "Windows PC is not connected.",
        });
      if (host.platform !== "win32")
        return yield* new DesktopLinkError({
          code: "HOST_NOT_WINDOWS",
          message: "Only Windows PCs can link folders.",
        });
      if (host.auth.sessionId !== caller.sessionId)
        return yield* new DesktopLinkError({
          code: "HOST_SESSION_MISMATCH",
          message: "Link folders from the desktop app on this PC.",
        });
      const winPath = yield* Effect.try({
        try: () => normalizeWinPath(input.winPath),
        catch: (error) => (isDesktopLinkError(error) ? error : failure(error)),
      });
      const matching =
        yield* sql`SELECT project_id AS "projectId", host_id AS "hostId", host_name AS "hostName", win_path AS "winPath", server_path AS "serverPath", created_at AS "createdAt" FROM desktop_linked_projects WHERE host_id=${host.hostId} AND win_path_key=${winPath.toLowerCase()}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DesktopLinkedProject))),
        );
      const existing = matching[0];
      if (existing) {
        if (Option.isSome(yield* query.getProjectShellById(existing.projectId)))
          return { ...existing, created: false };
        yield* removeRow(existing.projectId);
      }
      const title = winPath.split("\\").at(-1)!;
      const parent = path.join(root, desktopLinkSlug(host.hostName, host.hostId.slice(0, 8)));
      yield* fs.makeDirectory(parent, { recursive: true });
      const slug = desktopLinkSlug(title);
      const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
      let directory: string | undefined;
      let dispatched = false;
      let settingsWritten = false;
      const compensate = <A, E>(step: Effect.Effect<A, E>) =>
        step.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logError("Desktop link rollback failed", { cause })),
        );
      const cleanup = Effect.gen(function* () {
        // Attempt every compensation even if another cleanup step fails.
        yield* compensate(removeRow(projectId));
        if (settingsWritten)
          yield* compensate(
            settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } }),
          );
        if (dispatched) yield* compensate(deleteProject(projectId, directory));
        if (directory) yield* compensate(fs.remove(directory, { recursive: true, force: true }));
      });
      return yield* Effect.gen(function* () {
        for (let i = 1; i <= 100; i++) {
          const candidate = path.join(parent, i === 1 ? slug : `${slug}-${i}`);
          if (Option.isSome(yield* query.getActiveProjectByWorkspaceRoot(candidate))) continue;
          const allocated = yield* fs.makeDirectory(candidate).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
          if (allocated) {
            directory = candidate;
            break;
          }
        }
        if (!directory) return yield* failure("No available directory after 100 attempts.");
        yield* git.initRepository({ cwd: directory });
        const createdAt = yield* now;
        // Include a committed project in rollback even if dispatch fails while acknowledging it.
        dispatched = true;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          projectId,
          title,
          workspaceRoot: directory,
          createdAt,
        });
        settingsWritten = true;
        yield* settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { enableAgentWinAccess: true } },
        });
        yield* sql`INSERT INTO desktop_linked_projects (project_id,host_id,host_name,win_path,win_path_key,server_path,created_at,updated_at) VALUES (${projectId},${host.hostId},${host.hostName},${winPath},${winPath.toLowerCase()},${directory},${createdAt},${createdAt})`;
        return {
          projectId,
          hostId: host.hostId,
          hostName: host.hostName,
          winPath,
          serverPath: directory,
          createdAt,
          created: true,
        };
      }).pipe(
        Effect.catchCause((cause) =>
          cleanup.pipe(Effect.andThen(Effect.fail(failure(Cause.pretty(cause))))),
        ),
      );
    },
    Effect.mapError((error) => (isDesktopLinkError(error) ? error : failure(error))),
    Effect.uninterruptible,
    semaphore.withPermits(1),
  );
  const list: DesktopLinkService["Service"]["list"] = Effect.fn("DesktopLinkService.list")(
    function* () {
      const hosts = yield* broker.listHosts();
      const links: DesktopLinkedProject[] = [];
      for (const row of yield* rows()) {
        if (Option.isNone(yield* query.getProjectShellById(row.projectId))) {
          yield* removeRow(row.projectId);
          continue;
        }
        const host = hosts.find((h) => h.hostId === row.hostId);
        if (host && host.hostName !== row.hostName) {
          yield* sql`UPDATE desktop_linked_projects SET host_name=${host.hostName}, updated_at=${yield* now} WHERE project_id=${row.projectId}`;
          links.push({ ...row, hostName: host.hostName });
        } else links.push(row);
      }
      return links;
    },
    Effect.mapError(failure),
    semaphore.withPermits(1),
  );
  const unlink: DesktopLinkService["Service"]["unlink"] = Effect.fn("DesktopLinkService.unlink")(
    function* ({ projectId, deleteServerCopy }) {
      const link = (yield* rows()).find((r) => r.projectId === projectId);
      if (!link)
        return yield* new DesktopLinkError({
          code: "NOT_LINKED",
          message: "Project is not linked.",
        });
      if (deleteServerCopy) {
        const exists = yield* fs.exists(link.serverPath);
        if (exists) {
          const safe = yield* Effect.gen(function* () {
            const rootReal = yield* fs.realPath(root);
            const copyReal = yield* fs.realPath(link.serverPath);
            const relative = path.relative(rootReal, copyReal);
            return (
              relative !== "" &&
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
            );
          }).pipe(Effect.orElseSucceed(() => false));
          if (!safe)
            return yield* new DesktopLinkError({
              code: "UNSAFE_PATH",
              message: "Server copy is outside the Windows projects root.",
            });
        }
        yield* deleteProject(projectId);
        if (exists) yield* fs.remove(link.serverPath, { recursive: true, force: true });
      }
      yield* removeRow(projectId);
      yield* Effect.gen(function* () {
        const override = deleteServerCopy
          ? null
          : { ...(yield* settings.getSettings).projectSettingsOverrides[projectId] };
        if (override) delete override.enableAgentWinAccess;
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: override && Object.keys(override).length > 0 ? override : null,
          },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to clean up unlinked project settings", {
                projectId,
                cause,
              }),
        ),
      );
      return { projectId, serverCopyDeleted: deleteServerCopy };
    },
    Effect.mapError((error) => (isDesktopLinkError(error) ? error : failure(error))),
    Effect.uninterruptible,
    semaphore.withPermits(1),
  );
  const resolveConflict: DesktopLinkService["Service"]["resolveConflict"] = Effect.fn(
    "DesktopLinkService.resolveConflict",
  )(
    function* ({ projectId, path: conflictPath }) {
      const link = yield* getLinkForProject(projectId);
      if (Option.isNone(link))
        return yield* new DesktopLinkError({
          code: "NOT_LINKED",
          message: "Project is not linked.",
        });
      const invalid = () =>
        new DesktopLinkError({
          code: "INVALID_CONFLICT_PATH",
          message:
            "Conflict path must stay inside the linked project and outside its internal .git repository.",
        });
      const segments = conflictPath.split(/[\\/]/u);
      if (
        !conflictPath ||
        /^[\\/]|^[a-z]:/iu.test(conflictPath) ||
        conflictPath.includes("\0") ||
        segments.some((segment) => segment === ".." || segment === "." || segment === "") ||
        segments[0]?.toLowerCase() === ".git"
      )
        return yield* invalid();
      const serverReal = yield* fs.realPath(link.value.serverPath).pipe(Effect.mapError(invalid));
      const inside = (target: string, allowRoot = false) => {
        const relative = path.relative(serverReal, target);
        return (
          (allowRoot || relative !== "") &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      };
      const target = path.resolve(serverReal, ...segments);
      if (!inside(target)) return yield* invalid();
      let parent = path.dirname(target);
      let missingParent = false;
      while (true) {
        const parentReal = yield* fs.realPath(parent).pipe(
          Effect.map(Option.some),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
          Effect.mapError(invalid),
        );
        if (Option.isSome(parentReal)) {
          if (
            !inside(parentReal.value, true) ||
            path.relative(serverReal, parentReal.value).split(path.sep)[0]?.toLowerCase() === ".git"
          )
            return yield* invalid();
          break;
        }
        // Check the nearest existing ancestor even when the conflicting copy's
        // parent vanished, so a missing child cannot hide an escaping symlink.
        const ancestor = path.dirname(parent);
        if (parent === serverReal || ancestor === parent) return yield* invalid();
        missingParent = true;
        parent = ancestor;
      }
      if (missingParent) return { projectId, path: conflictPath, removed: false };
      // FileSystem.remove uses rm semantics: symlinks (including dangling links) are
      // unlinked themselves, while directories are removed recursively.
      const removed = yield* fs.remove(target, { recursive: true }).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      return { projectId, path: conflictPath, removed };
    },
    Effect.mapError((error) => (isDesktopLinkError(error) ? error : failure(error))),
    Effect.uninterruptible,
    semaphore.withPermits(1),
  );
  return DesktopLinkService.of({ createProject, list, unlink, getLinkForProject, resolveConflict });
});
export const layer = Layer.effect(DesktopLinkService, make);
