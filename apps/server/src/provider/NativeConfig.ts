// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Crypto from "effect/Crypto";
import {
  ClaudeSettings,
  CodexSettings,
  NativeConfigError,
  type NativeConfigTarget,
  type NativeConfigFile,
  type NativeConfigList,
  type NativeConfigReadInput,
  type NativeConfigWriteInput,
  type NativeConfigDocument,
  type NativeConfigWriteResult,
  type NativeConfigUndoInput,
} from "@t3tools/contracts";
import { parseNativeConfig } from "@t3tools/shared/nativeConfig";
import { createPatch } from "diff";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";

const isNativeConfigError = Schema.is(NativeConfigError);
const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);

const MAX_BYTES = 256 * 1024;
const MAX_FILES = 500;
const failure = (reason: NativeConfigError["reason"], detail: string) =>
  new NativeConfigError({ reason, detail });
const missing = (cause: unknown) =>
  cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT";

export class NativeConfig extends Context.Service<
  NativeConfig,
  {
    readonly list: (
      input: NativeConfigTarget,
    ) => Effect.Effect<NativeConfigList, NativeConfigError>;
    readonly read: (
      input: NativeConfigReadInput,
    ) => Effect.Effect<NativeConfigDocument, NativeConfigError>;
    readonly preview: (input: NativeConfigWriteInput) => Effect.Effect<string, NativeConfigError>;
    readonly write: (
      input: NativeConfigWriteInput,
    ) => Effect.Effect<NativeConfigWriteResult, NativeConfigError>;
    readonly undo: (
      input: NativeConfigUndoInput,
    ) => Effect.Effect<NativeConfigDocument, NativeConfigError>;
  }
>()("t3/provider/NativeConfig") {}

async function resolvedPath(filePath: string, links = 0): Promise<string> {
  if (links > 40) throw failure("unavailable", "This path contains too many symbolic links.");
  try {
    return await NodeFSP.realpath(filePath);
  } catch (cause) {
    if (!missing(cause)) throw cause;
    // A dangling link is still an alias: creating its target must not replace
    // the link itself. The same applies to a missing file below a linked home.
    try {
      if ((await NodeFSP.lstat(filePath)).isSymbolicLink()) {
        const link = await NodeFSP.readlink(filePath);
        return resolvedPath(NodePath.resolve(NodePath.dirname(filePath), link), links + 1);
      }
    } catch (linkCause) {
      if (!missing(linkCause)) throw linkCause;
    }
    // Resolve existing parents too: a missing file below a redirected home
    // must conflict if that symlink changes while the user is editing.
    const parent = NodePath.dirname(filePath);
    if (parent === filePath) throw cause;
    return NodePath.join(await resolvedPath(parent, links), NodePath.basename(filePath));
  }
}

async function writable(filePath: string): Promise<boolean> {
  try {
    const stat = await NodeFSP.stat(filePath);
    if ((stat.mode & 0o222) === 0) return false;
    await NodeFSP.access(
      filePath,
      NodeFS.constants.W_OK | (stat.isDirectory() ? NodeFS.constants.X_OK : 0),
    );
    return true;
  } catch (cause) {
    if (!missing(cause)) return false;
    const parent = NodePath.dirname(filePath);
    return parent !== filePath && writable(parent);
  }
}

async function describe(
  filePath: string,
  scope: NativeConfigFile["scope"],
  kind: NativeConfigFile["kind"],
): Promise<NativeConfigFile> {
  let exists = false;
  let problem: string | null = null;
  try {
    const stat = await NodeFSP.stat(filePath);
    exists = true;
    if (!stat.isFile()) problem = "This path is not a regular file.";
    else if (stat.size > MAX_BYTES) problem = "This file exceeds the 256 KiB editor limit.";
  } catch (cause) {
    if (!missing(cause)) problem = "This file cannot be accessed.";
  }
  return {
    path: filePath,
    scope,
    kind,
    format: filePath.endsWith(".toml") ? "toml" : filePath.endsWith(".json") ? "json" : "markdown",
    exists,
    writable:
      scope !== "managed" &&
      !problem &&
      (await writable(filePath)) &&
      (await writable(NodePath.dirname(await resolvedPath(filePath)))),
    problem,
  };
}

async function readDocument(file: NativeConfigFile): Promise<NativeConfigDocument> {
  if (file.problem) throw failure("unavailable", file.problem);
  const target = await resolvedPath(file.path);
  let content = "";
  let identity = "missing";
  let exists = false;
  try {
    const handle = await NodeFSP.open(target, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw failure("unavailable", "Only text files up to 256 KiB can be edited.");
      // A bounded read also covers a file growing after stat().
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_BYTES)
        throw failure("unavailable", "This file exceeds the 256 KiB editor limit.");
      const after = await handle.stat();
      if (
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        after.size !== stat.size
      )
        throw failure("conflict", "The file changed while being read. Reload it to continue.");
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead),
        );
      } catch {
        throw failure("unavailable", "This file is not UTF-8 text.");
      }
      if (content.includes("\0")) throw failure("unavailable", "This file is not UTF-8 text.");
      identity = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
      exists = true;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  return {
    file: { ...file, exists },
    resolvedPath: target,
    content,
    revision: NodeCrypto.createHash("sha256")
      .update(`${target}\0${identity}\0${content}`)
      .digest("hex"),
  };
}

function validate(content: string, format: NativeConfigFile["format"]) {
  if (Buffer.byteLength(content) > MAX_BYTES || content.includes("\0") || !content.isWellFormed())
    throw failure("invalid", "Only text files up to 256 KiB can be saved.");
  if (format !== "markdown") {
    try {
      parseNativeConfig(content, format);
    } catch {
      throw failure(
        "invalid",
        format === "toml"
          ? "Invalid TOML. The file was not changed."
          : "Invalid JSON object. The file was not changed.",
      );
    }
  }
}

// Claude can read the main checkout's local settings from a linked worktree.
// Discover the candidate from bounded Git metadata reads, without starting Git
// or guessing a checkout from Claude's encoded history directory names.
async function claudeRepositoryLocalPath(cwd: string): Promise<string | undefined> {
  let root = cwd;
  for (;;) {
    const gitPath = NodePath.join(root, ".git");
    try {
      const stat = await NodeFSP.stat(gitPath);
      let mainRoot = root;
      if (stat.isFile()) {
        const gitFile = await readDocument(await describe(gitPath, "project", "instructions"));
        const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile.content);
        if (match) {
          const gitDir = NodePath.resolve(root, match[1]!.trim());
          const commonFile = await readDocument(
            await describe(NodePath.join(gitDir, "commondir"), "project", "instructions"),
          );
          if (commonFile.file.exists) {
            const commonDir = NodePath.resolve(gitDir, commonFile.content.trim());
            if (NodePath.basename(commonDir) === ".git") mainRoot = NodePath.dirname(commonDir);
          }
        }
      }
      return NodePath.join(mainRoot, ".claude", "settings.local.json");
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
    const parent = NodePath.dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig;
  const platform = yield* HostProcessPlatform;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(() =>
      failure("unavailable", "Could not create a configuration operation identifier."),
    ),
  );
  const writes = yield* Semaphore.make(1);
  const undoRecords = new Map<
    string,
    { input: NativeConfigReadInput; before: NativeConfigDocument; after: string }
  >();
  const io = <A>(action: () => Promise<A>) =>
    Effect.tryPromise({
      try: action,
      catch: (cause) =>
        isNativeConfigError(cause)
          ? cause
          : failure(
              "unavailable",
              "The native configuration file could not be accessed. Check its path and permissions.",
            ),
    });

  const list = Effect.fn("NativeConfig.list")(function* (input: NativeConfigTarget) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("unavailable", "Provider settings are unavailable.")),
    );
    const instance = current.providerInstances[input.instanceId];
    if (!instance || (instance.driver !== "codex" && instance.driver !== "claudeAgent"))
      return yield* failure(
        "unsupported",
        "Native configuration editing is available for Codex and Claude Code instances.",
      );
    const driver = instance.driver === "codex" ? ("codex" as const) : ("claudeAgent" as const);
    const environment = mergeProviderInstanceEnvironment(instance.environment);
    const cwd = input.cwd ? NodePath.resolve(expandHomePath(input.cwd)) : undefined;
    let homePath: string;
    let sharedCodexHome: string | undefined;
    let hasLaunchOverrides = false;
    if (driver === "codex") {
      const native = yield* decodeCodex(instance.config ?? {}).pipe(
        Effect.mapError(() =>
          failure("invalid", "This Codex instance has invalid runtime settings."),
        ),
      );
      const layout = yield* (
        native.setupMode === "managed"
          ? resolveManagedCodexHomeLayout(config.stateDir, input.instanceId, native)
          : resolveCodexHomeLayout(native)
      ).pipe(Effect.provideService(Path.Path, pathService));
      sharedCodexHome = layout.mode === "authOverlay" ? layout.sharedHomePath : undefined;
      homePath =
        layout.effectiveHomePath ??
        (native.setupMode === "managed"
          ? layout.sharedHomePath
          : NodePath.resolve(
              cwd ?? process.cwd(),
              environment.CODEX_HOME?.trim() || layout.sharedHomePath,
            ));
      hasLaunchOverrides =
        native.setupMode === "managed" ||
        Boolean(native.launchArgs.trim() || environment.T3CODE_CODEX_LAUNCH_ARGS?.trim());
    } else {
      const native = yield* decodeClaude(instance.config ?? {}).pipe(
        Effect.mapError(() =>
          failure("invalid", "This Claude instance has invalid runtime settings."),
        ),
      );
      homePath = native.homePath.trim()
        ? NodePath.resolve(expandHomePath(native.homePath))
        : NodePath.resolve(
            cwd ?? process.cwd(),
            environment.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".claude"),
          );
    }
    return yield* io(async (): Promise<NativeConfigList> => {
      const files: NativeConfigFile[] = [];
      let truncated = false;
      const seen = new Set<string>();
      const add = async (
        filePath: string,
        scope: NativeConfigFile["scope"],
        kind: NativeConfigFile["kind"],
      ) => {
        if (seen.has(filePath)) return;
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        seen.add(filePath);
        files.push(await describe(filePath, scope, kind));
      };
      const existing = async (
        filePath: string,
        scope: NativeConfigFile["scope"],
        kind: NativeConfigFile["kind"],
      ) => {
        try {
          await NodeFSP.lstat(filePath);
          await add(filePath, scope, kind);
        } catch (cause) {
          if (!missing(cause)) truncated = true;
        }
      };
      const visited = new Set<string>();
      let directories = 0;
      const scan = async (
        directory: string,
        scope: NativeConfigFile["scope"],
        kind: NativeConfigFile["kind"],
        depth = 0,
      ): Promise<void> => {
        if (depth > 5 || files.length >= MAX_FILES || directories >= 1000) {
          truncated = true;
          return;
        }
        try {
          const real = await NodeFSP.realpath(directory);
          if (visited.has(real)) return;
          visited.add(real);
          directories++;
          const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const target = NodePath.join(directory, entry.name);
            if (
              entry.isDirectory() ||
              (entry.isSymbolicLink() && (await NodeFSP.stat(target)).isDirectory())
            )
              await scan(target, scope, kind, depth + 1);
            else if (kind === "skill" ? entry.name === "SKILL.md" : entry.name.endsWith(".md"))
              await add(target, scope, kind);
          }
        } catch (cause) {
          if (!missing(cause)) truncated = true;
        }
      };
      if (driver === "codex") {
        const sourceHome = sharedCodexHome ?? homePath;
        await add(NodePath.join(sourceHome, "config.toml"), "user", "settings");
        await add(NodePath.join(sourceHome, "AGENTS.md"), "user", "instructions");
        await add(NodePath.join(sourceHome, "AGENTS.override.md"), "user", "instructions");
        try {
          for (const name of (await NodeFSP.readdir(sourceHome)).sort()) {
            if (name.endsWith(".config.toml"))
              await add(NodePath.join(sourceHome, name), "user", "settings");
          }
        } catch (cause) {
          if (!missing(cause)) truncated = true;
        }
        if (platform !== "win32") {
          await existing("/etc/codex/requirements.toml", "managed", "settings");
          await existing("/etc/codex/managed_config.toml", "managed", "settings");
        }
        if (cwd) {
          await add(NodePath.join(cwd, ".codex", "config.toml"), "project", "settings");
          await add(NodePath.join(cwd, "AGENTS.md"), "project", "instructions");
          await add(NodePath.join(cwd, "AGENTS.override.md"), "project", "instructions");
        }
        await scan(NodePath.join(sourceHome, "skills"), "user", "skill");
        await scan(NodePath.join(NodeOS.homedir(), ".agents", "skills"), "user", "skill");
        if (cwd) await scan(NodePath.join(cwd, ".agents", "skills"), "project", "skill");
        await scan(NodePath.join(homePath, "memories"), "memory", "memory");
      } else {
        const settingsPaths = [NodePath.join(homePath, "settings.json")];
        await add(settingsPaths[0]!, "user", "settings");
        await add(NodePath.join(homePath, "CLAUDE.md"), "user", "instructions");
        await scan(NodePath.join(homePath, "rules"), "user", "rules");
        const managedRoot =
          platform === "darwin"
            ? "/Library/Application Support/ClaudeCode"
            : platform === "win32"
              ? NodePath.join(environment.PROGRAMDATA || "C:\\ProgramData", "ClaudeCode")
              : "/etc/claude-code";
        await existing(NodePath.join(managedRoot, "managed-settings.json"), "managed", "settings");
        await existing(NodePath.join(managedRoot, "CLAUDE.md"), "managed", "instructions");
        if (cwd) {
          settingsPaths.push(
            NodePath.join(cwd, ".claude", "settings.json"),
            NodePath.join(cwd, ".claude", "settings.local.json"),
          );
          await add(settingsPaths[1]!, "project", "settings");
          await add(settingsPaths[2]!, "local", "settings");
          try {
            const rootLocal = await claudeRepositoryLocalPath(cwd);
            if (rootLocal && rootLocal !== settingsPaths[2]) {
              settingsPaths.push(rootLocal);
              await existing(rootLocal, "local", "settings");
            }
          } catch {
            truncated = true;
          }
          await add(NodePath.join(cwd, "CLAUDE.md"), "project", "instructions");
          await add(NodePath.join(cwd, "CLAUDE.local.md"), "local", "instructions");
          await add(NodePath.join(cwd, ".claude", "CLAUDE.md"), "project", "instructions");
          await add(NodePath.join(cwd, "AGENTS.md"), "project", "instructions");
          await scan(NodePath.join(cwd, ".claude", "rules"), "project", "rules");
        }
        await scan(NodePath.join(homePath, "skills"), "user", "skill");
        if (cwd) await scan(NodePath.join(cwd, ".claude", "skills"), "project", "skill");
        // Memory folders are listed by their actual on-disk path, never by a
        // guessed cwd encoding. The CLI owns project/worktree identity.
        try {
          const projects = await NodeFSP.readdir(NodePath.join(homePath, "projects"));
          if (projects.length > 200) truncated = true;
          for (const project of projects.sort().slice(0, 200))
            await scan(NodePath.join(homePath, "projects", project, "memory"), "memory", "memory");
        } catch (cause) {
          if (!missing(cause)) truncated = true;
        }
        for (const settingsPath of settingsPaths) {
          try {
            const document = await readDocument(await describe(settingsPath, "user", "settings"));
            if (!document.file.exists) continue;
            const value = parseNativeConfig(document.content, "json").autoMemoryDirectory;
            if (typeof value === "string" && (NodePath.isAbsolute(value) || value.startsWith("~/")))
              await scan(expandHomePath(value), "memory", "memory");
          } catch {
            /* A malformed settings file remains available for repair. */
          }
        }
      }
      // Ancestor files are candidates, not proof of loading. Provider trust,
      // repository roots and native exclusion rules decide applicability.
      if (cwd) {
        let parent = NodePath.dirname(cwd);
        for (;;) {
          if (driver === "codex") {
            await existing(NodePath.join(parent, "AGENTS.md"), "project", "instructions");
            await existing(NodePath.join(parent, "AGENTS.override.md"), "project", "instructions");
            await existing(NodePath.join(parent, ".codex", "config.toml"), "project", "settings");
          } else {
            await existing(NodePath.join(parent, "CLAUDE.md"), "project", "instructions");
            await existing(NodePath.join(parent, "CLAUDE.local.md"), "local", "instructions");
            await existing(NodePath.join(parent, "AGENTS.md"), "project", "instructions");
            await existing(
              NodePath.join(parent, ".claude", "CLAUDE.md"),
              "project",
              "instructions",
            );
          }
          const next = NodePath.dirname(parent);
          if (next === parent) break;
          parent = next;
        }
      }
      return {
        driver,
        homePath,
        files,
        truncated,
        hasLaunchOverrides,
        environmentOverrides: Object.keys(environment)
          .filter((name) => /^(CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|BASH_|API_TIMEOUT_MS$)/.test(name))
          .sort(),
      };
    });
  });

  const read = Effect.fn("NativeConfig.read")(function* (input: NativeConfigReadInput) {
    const catalog = yield* list(input);
    const file = catalog.files.find((entry) => entry.path === input.path);
    if (!file)
      return yield* failure(
        "unavailable",
        "This file is no longer in the instance's native configuration sources. Refresh the file list.",
      );
    return yield* io(() => readDocument(file));
  });

  const prepare = Effect.fn("NativeConfig.prepare")(function* (input: NativeConfigWriteInput) {
    const before = yield* read(input);
    if (before.revision !== input.revision)
      return yield* failure(
        "conflict",
        "The file changed outside this editor. Reload it before saving; your draft has been kept.",
      );
    if (!before.file.writable)
      return yield* failure("readonly", "This native configuration source is read-only.");
    yield* io(async () => validate(input.content, before.file.format));
    return before;
  });

  const replace = async (before: NativeConfigDocument, content: string | null, id: string) => {
    const target = before.resolvedPath;
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    const temp = NodePath.join(NodePath.dirname(target), `.t3-config-${id}.tmp`);
    try {
      if (content !== null) {
        const stat = before.file.exists ? await NodeFSP.stat(target) : undefined;
        const handle = await NodeFSP.open(temp, "wx", stat ? stat.mode & 0o777 : 0o600);
        try {
          if (stat) {
            await handle.chmod(stat.mode & 0o777);
            if (
              process.getuid &&
              (stat.uid !== process.getuid() || stat.gid !== process.getgid?.())
            )
              await handle.chown(stat.uid, stat.gid);
          }
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      // Serialize T3 writers and recheck external changes immediately before
      // atomic replacement. Non-cooperating filesystem writers cannot share a
      // cross-platform compare-and-swap primitive with rename().
      const current = await readDocument(before.file);
      if (current.revision !== before.revision)
        throw failure(
          "conflict",
          "The file changed outside this editor. Reload it before saving; your draft has been kept.",
        );
      if (content === null) await NodeFSP.unlink(target);
      else await NodeFSP.rename(temp, target);
      const document = await readDocument({ ...before.file, exists: content !== null });
      if (document.file.exists !== (content !== null) || document.content !== (content ?? ""))
        throw failure(
          "conflict",
          "The file changed immediately after saving. Reload it to inspect the latest contents.",
        );
      return document;
    } finally {
      await NodeFSP.rm(temp, { force: true });
    }
  };

  const preview = Effect.fn("NativeConfig.preview")(function* (input: NativeConfigWriteInput) {
    const before = yield* prepare(input);
    const diff = createPatch(
      input.path,
      before.content,
      input.content,
      before.file.exists ? "saved" : "missing",
      "draft",
      { timeout: 250, maxEditLength: 10000 },
    );
    if (diff === undefined)
      return yield* failure(
        "unavailable",
        "This change is too large for a diff preview. Compare the saved file with the raw draft.",
      );
    return diff;
  });
  const write = Effect.fn("NativeConfig.write")(function* (input: NativeConfigWriteInput) {
    return yield* writes
      .withPermits(1)(
        Effect.gen(function* () {
          const before = yield* prepare(input);
          const undoToken = yield* uuid;
          const document = yield* io(() => replace(before, input.content, undoToken));
          undoRecords.set(undoToken, {
            input: {
              instanceId: input.instanceId,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              path: input.path,
            },
            before,
            after: document.revision,
          });
          while (undoRecords.size > 20) undoRecords.delete(undoRecords.keys().next().value!);
          return { document, undoToken };
        }),
      )
      .pipe(Effect.uninterruptible);
  });
  const undo = Effect.fn("NativeConfig.undo")(function* (input: NativeConfigUndoInput) {
    return yield* writes
      .withPermits(1)(
        Effect.gen(function* () {
          const record = undoRecords.get(input.undoToken);
          if (!record)
            return yield* failure(
              "expired",
              "Undo is no longer available. Reload the file to continue.",
            );
          const current = yield* read(record.input);
          if (current.revision !== record.after)
            return yield* failure(
              "conflict",
              "The file changed after your save. Undo was stopped to preserve those changes.",
            );
          if (!current.file.writable)
            return yield* failure("readonly", "This native configuration source is read-only.");
          const id = yield* uuid;
          const document = yield* io(() =>
            replace(current, record.before.file.exists ? record.before.content : null, id),
          );
          undoRecords.delete(input.undoToken);
          return document;
        }),
      )
      .pipe(Effect.uninterruptible);
  });
  return NativeConfig.of({ list, read, preview, write, undo });
});

export const layer = Layer.effect(NativeConfig, make);
