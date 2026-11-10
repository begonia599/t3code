// @effect-diagnostics nodeBuiltinImport:off -- Native filesystem and process adapter behind an Effect service.
// @effect-diagnostics globalTimers:off -- Promise handlers use AbortSignal and native process/grant deadlines.
// @effect-diagnostics globalDate:off -- Durable timestamps at the native request boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  DESKTOP_EXEC_CHUNK_BYTES,
  DESKTOP_EXEC_OUTPUT_LIMIT_BYTES,
  DESKTOP_EXEC_MAX_CONCURRENT_PER_HOST,
  DesktopExecInput,
  DesktopExecErrorCode,
  DesktopExecLogInput,
  DesktopStatusInput,
  type DesktopExecResult,
  type DesktopExecProgress,
  type DesktopExecLogEntry,
  type DesktopChannelCapabilities,
} from "@t3tools/contracts";
import { SyncEnvironment } from "../sync/SyncEnvironment.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { DesktopAppSettings, type DesktopSettings } from "../settings/DesktopAppSettings.ts";
import { RemoteControlStore } from "./RemoteControlStore.ts";
import type { RequestHandler } from "./RemoteControlRequestRouter.ts";
import { resolveWindowsCwd } from "./paths.ts";
import {
  cmdCommandLine,
  commandSummary,
  createOutputDecoder,
  takeUtf8,
  windowsExecutableCandidates,
} from "./execHelpers.ts";

const isExecErrorCode = Schema.is(DesktopExecErrorCode);
const fail = (code: string, message = code) => Object.assign(new Error(message), { code });
const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
type Emit = Parameters<RequestHandler>[0]["emit"];
const progress = (emit: Emit, value: DesktopExecProgress) =>
  emit({ kind: "progress", data: JSON.stringify(value) });

export async function resolveExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const candidates =
    platform === "win32"
      ? windowsExecutableCandidates(command, cwd, env)
      : command.includes("/")
        ? [NodePath.resolve(cwd, command)]
        : (env.PATH ?? "")
            .split(NodePath.delimiter)
            .map((dir) => NodePath.resolve(cwd, dir, command));
  for (const candidate of candidates) {
    try {
      if (!(await NodeFSP.stat(candidate)).isFile()) continue;
      await NodeFSP.access(
        candidate,
        platform === "win32" ? NodeFSP.constants.F_OK : NodeFSP.constants.X_OK,
      );
      return candidate;
    } catch {
      /* Try the next PATH candidate. */
    }
  }
  throw fail("SPAWN_NOT_FOUND", `Program not found: ${command}`);
}

function mergedEnvironment(overlay: Readonly<Record<string, string>>, platform: NodeJS.Platform) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overlay)) {
    if (platform === "win32")
      for (const existing of Object.keys(env))
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    env[key] = value;
  }
  if (!Object.keys(env).some((key) => key.toUpperCase() === "PYTHONIOENCODING"))
    env.PYTHONIOENCODING = "utf-8";
  return env;
}

/** Wait for close (including both pipes), even after timeout, cancellation, or an emit failure. */
export async function runProcess(options: {
  platform: NodeJS.Platform;
  executable: string;
  args: readonly string[];
  cwd: string;
  winCwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  emit: Emit;
  windowsVerbatimArguments?: boolean;
  onStarted?: (pid: number, emit: Emit) => Promise<void>;
}): Promise<DesktopExecResult> {
  if (options.signal.aborted) throw fail("CANCELLED");
  const startedAt = Date.now();
  const child = NodeChildProcess.spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: options.platform !== "win32",
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  });
  child.stdout.pause();
  child.stderr.pause();
  const decoders = { stdout: createOutputDecoder(), stderr: createOutputDecoder() };
  const bytes = { stdout: 0, stderr: 0 };
  let outcome: DesktopExecResult["outcome"] = "exited";
  let truncated = false;
  let error: unknown;
  let chain = Promise.resolve();
  let closed = false;
  let killing = false;
  const delivery = new AbortController();
  let pendingOutput = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killTree = () => {
    if (closed || killing) return;
    killing = true;
    delivery.abort();
    if (child.pid !== undefined) {
      if (options.platform === "win32") {
        const killer = NodeChildProcess.spawn(
          "taskkill.exe",
          ["/T", "/F", "/PID", String(child.pid)],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        killer.on("error", () => {
          child.kill("SIGKILL");
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if (!(typeof cause === "object" && cause && "code" in cause && cause.code === "ESRCH"))
            child.kill("SIGKILL");
        }
      }
    }
    child.stdout.resume();
    child.stderr.resume();
  };
  const abort = () => {
    outcome = "cancelled";
    killTree();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const emit = async (event: Parameters<Emit>[0]) => {
    if (delivery.signal.aborted) return;
    // A blocked downstream consumer must not keep cancelled processes alive.
    let cleanup = () => {};
    const cancelled = new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      cleanup = () => delivery.signal.removeEventListener("abort", onAbort);
      delivery.signal.addEventListener("abort", onAbort, { once: true });
      if (delivery.signal.aborted) resolve();
    });
    try {
      await Promise.race([options.emit(event), cancelled]);
    } finally {
      cleanup();
    }
  };
  const output = async (kind: "stdout" | "stderr", chunk?: Buffer, final = false) => {
    const decoded = decoders[kind].decode(chunk, final);
    if (options.signal.aborted || error || truncated) return;
    let remaining = decoded;
    while (remaining) {
      const available = DESKTOP_EXEC_OUTPUT_LIMIT_BYTES - bytes.stdout - bytes.stderr;
      if (available <= 0) {
        if (!truncated) {
          truncated = true;
          await progress(emit, { type: "truncated", limitBytes: DESKTOP_EXEC_OUTPUT_LIMIT_BYTES });
        }
        break;
      }
      const part = takeUtf8(remaining, Math.min(DESKTOP_EXEC_CHUNK_BYTES, available));
      if (!part.bytes) {
        if (!truncated) {
          truncated = true;
          await progress(emit, { type: "truncated", limitBytes: DESKTOP_EXEC_OUTPUT_LIMIT_BYTES });
        }
        break;
      }
      bytes[kind] += part.bytes;
      await emit({ kind, data: part.text });
      remaining = remaining.slice(part.text.length);
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    child.stdout.pause();
    child.stderr.pause();
    pendingOutput++;
    chain = chain
      .then(work)
      .catch((cause: unknown) => {
        error ??= cause;
        killTree();
      })
      .finally(() => {
        pendingOutput--;
        if (!pendingOutput || killing) {
          child.stdout.resume();
          child.stderr.resume();
        }
      });
  };
  child.stdout.on("data", (chunk: Buffer) => enqueue(() => output("stdout", chunk)));
  child.stderr.on("data", (chunk: Buffer) => enqueue(() => output("stderr", chunk)));
  child.stdout.on("end", () => enqueue(() => output("stdout", undefined, true)));
  child.stderr.on("end", () => enqueue(() => output("stderr", undefined, true)));
  child.on("error", (cause) => {
    error = fail(isMissing(cause) ? "SPAWN_NOT_FOUND" : "SPAWN_FAILED", cause.message);
  });
  const close = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    }),
  );
  child.once("spawn", () => {
    timer = setTimeout(() => {
      if (outcome !== "cancelled") outcome = "timedOut";
      killTree();
    }, options.timeoutMs);
    enqueue(() => options.onStarted?.(child.pid!, emit) ?? Promise.resolve());
    if (options.signal.aborted) abort();
  });
  try {
    const exitCode = await close;
    await chain;
    if (error && !options.signal.aborted) throw error;
    return {
      outcome,
      exitCode,
      durationMs: Date.now() - startedAt,
      winCwd: options.winCwd,
      stdoutBytes: bytes.stdout,
      stderrBytes: bytes.stderr,
      truncated,
      decodedAsGbk: decoders.stdout.decodedAsGbk || decoders.stderr.decodedAsGbk,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
}

export function createWinExecService(options: {
  platform: NodeJS.Platform;
  getConfig: () => Promise<DesktopSettings["remoteControl"]>;
  store: RemoteControlStore["Service"];
  /** Allows Linux tests to run the same execution pipeline against a real temporary directory. */
  localDirectory?: (winCwd: string) => string;
  syncEnvironment?: (environmentId: string) => Promise<Readonly<Record<string, string>>>;
}) {
  let active = 0;
  const queue: Array<() => void> = [];
  const controllers = new Set<AbortController>();
  const completions = new Set<Promise<void>>();
  let shells: Promise<string[]> | undefined;
  const getShells = () =>
    (shells ??= (async () => {
      const found: string[] = [];
      // Same order as DesktopShellEnvironment's private WINDOWS_SHELL_CANDIDATES.
      for (const shell of options.platform === "win32"
        ? ["pwsh.exe", "powershell.exe"]
        : ["pwsh", "powershell.exe"]) {
        try {
          found.push(await resolveExecutable(shell, process.cwd(), process.env, options.platform));
        } catch {
          /* Optional shell. */
        }
      }
      return found;
    })());
  const acquire = async (signal: AbortSignal, emit: Emit) => {
    if (signal.aborted) throw fail("CANCELLED");
    if (active < DESKTOP_EXEC_MAX_CONCURRENT_PER_HOST) {
      active++;
      return;
    }
    await progress(emit, { type: "queued" });
    if (signal.aborted) throw fail("CANCELLED");
    // A slot may have become free while the queued progress was under backpressure.
    if (active < DESKTOP_EXEC_MAX_CONCURRENT_PER_HOST) {
      active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(wake);
        if (index >= 0) queue.splice(index, 1);
        reject(fail("CANCELLED"));
      };
      const wake = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      queue.push(wake);
    });
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  const exec: RequestHandler = async ({ request, environmentId, signal: parentSignal, emit }) => {
    const controller = new AbortController();
    controllers.add(controller);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    completions.add(completion);
    const signal = AbortSignal.any([controller.signal, parentSignal]);
    const startedAt = new Date().toISOString();
    let acquired = false;
    let tempDir: string | undefined;
    let entry: DesktopExecLogEntry = {
      requestId: request.requestId,
      startedAt,
      finishedAt: null,
      threadId: request.context.threadId ?? null,
      provider: request.context.provider ?? null,
      label: request.context.label ?? null,
      mode: "argv",
      summary: "Invalid exec input",
      winCwd: null,
      outcome: "running",
      exitCode: null,
      errorCode: null,
      durationMs: null,
    };
    try {
      const input = decode(DesktopExecInput, request.input);
      entry = { ...entry, mode: input.mode, summary: commandSummary(input) };
      const config = await options.getConfig();
      if (!config.enabledEnvironmentIds.includes(environmentId))
        throw fail("REMOTE_DISABLED", "Remote control is disabled for this environment");
      const resolved = resolveWindowsCwd(input, config);
      const cwd = options.localDirectory?.(resolved.winCwd) ?? resolved.winCwd;
      entry = { ...entry, winCwd: resolved.winCwd };
      try {
        if (!(await NodeFSP.stat(cwd)).isDirectory()) throw new Error("not a directory");
      } catch (cause) {
        throw fail(
          "CWD_NOT_ALLOWED",
          `Directory does not exist or is inaccessible: ${resolved.winCwd}: ${String(cause)}`,
        );
      }
      await options.store.authorize(
        {
          environmentId,
          threadId: entry.threadId,
          provider: entry.provider,
          label: entry.label,
          mode: input.mode,
          summary: entry.summary,
          winCwd: resolved.winCwd,
          strictMode: config.strictMode,
        },
        signal,
        () => progress(emit, { type: "awaiting-grant" }),
      );
      await acquire(signal, emit);
      acquired = true;
      if (signal.aborted) throw fail("CANCELLED");
      const env = mergedEnvironment(
        { ...input.env, ...(await options.syncEnvironment?.(environmentId)) },
        options.platform,
      );
      if (resolved.mapping?.syncSession && !input.noSync) {
        const session = resolved.mapping.syncSession;
        await progress(emit, { type: "syncing", session });
        let stderr = "";
        try {
          const executable = await resolveExecutable("mutagen", cwd, env, options.platform);
          const result = await runProcess({
            platform: options.platform,
            executable,
            args: ["sync", "flush", session],
            cwd,
            winCwd: resolved.winCwd,
            env,
            timeoutMs: 60_000,
            signal,
            emit: async (event) => {
              if (event.kind === "stderr") stderr = (stderr + event.data).slice(-16_384);
            },
          });
          if (signal.aborted) throw fail("CANCELLED");
          if (result.outcome !== "exited" || result.exitCode !== 0)
            throw new Error(`mutagen ${result.outcome}, exit code ${result.exitCode}`);
        } catch (cause) {
          if (signal.aborted) throw fail("CANCELLED");
          throw fail("SYNC_FAILED", `${String(cause)}${stderr ? `: ${stderr}` : ""}`);
        }
      }
      let executable: string;
      let args: readonly string[];
      let windowsVerbatimArguments = false;
      if (input.mode === "argv") {
        executable = await resolveExecutable(input.argv[0]!, cwd, env, options.platform);
        args = input.argv.slice(1);
        if (options.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
          args = ["/d", "/s", "/c", cmdCommandLine(executable, args)];
          executable = await resolveExecutable("cmd.exe", cwd, env, options.platform);
          windowsVerbatimArguments = true;
        }
      } else {
        executable = (await getShells())[0] ?? "";
        if (!executable) throw fail("SPAWN_NOT_FOUND", "Neither pwsh nor powershell.exe was found");
        tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-win-exec-"));
        const script = NodePath.join(tempDir, "command.ps1");
        await NodeFSP.writeFile(
          script,
          `\uFEFF[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\r\n${input.script}`,
          "utf8",
        );
        args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
      }
      const result = await runProcess({
        platform: options.platform,
        executable,
        args,
        cwd,
        winCwd: resolved.winCwd,
        env,
        timeoutMs: input.timeoutMs,
        signal,
        emit,
        windowsVerbatimArguments,
        onStarted: async (pid, emitStarted) => {
          entry = { ...entry, startedAt: new Date().toISOString() };
          await options.store.appendAudit(entry);
          await progress(emitStarted, {
            type: "started",
            pid,
            winCwd: resolved.winCwd,
            executable,
          });
        },
      });
      entry = {
        ...entry,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };
      return result;
    } catch (cause) {
      const code =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        isExecErrorCode(cause.code)
          ? cause.code
          : "INTERNAL";
      entry = {
        ...entry,
        outcome: signal.aborted ? "cancelled" : "error",
        errorCode: signal.aborted ? "CANCELLED" : code,
        durationMs: Date.now() - Date.parse(startedAt),
      };
      throw fail(
        signal.aborted ? "CANCELLED" : code,
        cause instanceof Error
          ? cause.message
          : typeof cause === "object" &&
              cause !== null &&
              "message" in cause &&
              typeof cause.message === "string"
            ? cause.message
            : String(cause),
      );
    } finally {
      if (acquired) release();
      controllers.delete(controller);
      if (tempDir) await NodeFSP.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await options.store.appendAudit({ ...entry, finishedAt: new Date().toISOString() });
      completions.delete(completion);
      finish();
    }
  };
  const handlers: Record<string, RequestHandler> = {
    exec,
    log: async ({ request }) => {
      const input = decode(DesktopExecLogInput, request.input);
      try {
        return { entries: await options.store.readAudit(input) };
      } catch (cause) {
        throw fail("INTERNAL", `Cannot read execution audit: ${String(cause)}`);
      }
    },
    status: async ({ request, environmentId }) => {
      decode(DesktopStatusInput, request.input);
      const config = await options.getConfig();
      return {
        enabled: config.enabledEnvironmentIds.includes(environmentId),
        strictMode: config.strictMode,
        grant: options.store.grantState(environmentId, request.context.threadId),
        allowlist: config.allowlist,
        mappings: config.mappings,
        running: active,
        shells: await getShells(),
      };
    },
  };
  return {
    handlers,
    getCapabilities: async (): Promise<DesktopChannelCapabilities> => ({
      enabled: true,
      exec: { version: "1", shells: await getShells() },
    }),
    disconnectAll: async () => {
      for (const controller of controllers) controller.abort();
      options.store.rejectEnvironment();
      await Promise.all(completions);
    },
  };
}

function decode<A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (cause) {
    throw fail("BAD_REQUEST", `Invalid request input: ${String(cause)}`);
  }
}

export class WinExecService extends Context.Service<
  WinExecService,
  ReturnType<typeof createWinExecService>
>()("@t3tools/desktop/remoteControl/WinExecService") {}
export const layer = Layer.effect(
  WinExecService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const settings = yield* DesktopAppSettings;
    const store = yield* RemoteControlStore;
    const sync = yield* SyncEnvironment;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const service = createWinExecService({
      platform: environment.platform,
      getConfig: async () => (await run(settings.get)).remoteControl,
      store,
      syncEnvironment: sync.environment,
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => service.disconnectAll()));
    return service;
  }),
);
