// @effect-diagnostics preferSchemaOverJson:off - Standalone launcher uses only Node builtins.
import type { DesktopExecResult } from "@t3tools/contracts";

export interface WinLauncherRuntime {
  args: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  readFile: (path: string) => Promise<string>;
  stdin: () => Promise<string>;
  fetch: typeof fetch;
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void | Promise<void>;
  onSignal: (signal: string, listener: () => void) => () => void;
  constants: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    maxLog: number;
    errorCodes: Record<string, number>;
    resultCodes: Record<string, number>;
  };
}

/** Self-contained: serialized into the generated launcher, with all dependencies supplied. */
export async function runWinLauncher(io: WinLauncherRuntime): Promise<number> {
  const usage = `Usage: win [options] -- <program> [args...]\n       win [options] ps '<PowerShell script>' (or - for stdin)\n       win status [--host X] [--json]\n       win log [-n N] [--host X] [--json]\nOptions: --cwd <Windows path>, --timeout <seconds> (default 600), --no-sync,\n         --env K=V (repeatable), --host <name|id>, -h/--help\n`;
  const report = async (message: string, code: number) => {
    await io.stderr(`[win] ${message}\n`);
    return code;
  };
  let command = "";
  let argv: string[] = [];
  let script = "";
  let host = io.env.T3_WIN_HOST;
  let winCwd: string | undefined;
  let timeoutMs = io.constants.defaultTimeoutMs;
  let noSync = false;
  let json = false;
  let limit = 20;
  let hasLimit = false;
  const env: Record<string, string> = Object.create(null);
  const execFlags: string[] = [];
  try {
    for (let i = 0; i < io.args.length; i++) {
      const arg = io.args[i]!;
      const value = () => {
        const next = io.args[++i];
        if (!next || !next.trim()) throw new Error(`${arg} requires a value`);
        return next;
      };
      if (arg === "--help" || arg === "-h") {
        await io.stdout(usage);
        return 0;
      }
      if (arg === "--") {
        if (command) throw new Error("unexpected --");
        command = "exec";
        argv = io.args.slice(i + 1);
        if (!argv[0]?.trim()) throw new Error("a program is required after --");
        break;
      }
      if (arg === "--host") host = value();
      else if (arg === "--json") json = true;
      else if (arg === "-n") {
        hasLimit = true;
        const n = value();
        limit = Number(n);
        if (!/^\d+$/.test(n) || limit < 1 || limit > io.constants.maxLog)
          throw new Error(`-n must be between 1 and ${io.constants.maxLog}`);
      } else if (["--cwd", "--timeout", "--no-sync", "--env"].includes(arg)) {
        execFlags.push(arg);
        if (arg === "--cwd") winCwd = value();
        if (arg === "--timeout") {
          const seconds = value();
          timeoutMs = Number(seconds) * 1000;
          if (
            !/^\d+(\.\d+)?$/.test(seconds) ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > io.constants.maxTimeoutMs
          )
            throw new Error(
              `--timeout must be positive and at most ${io.constants.maxTimeoutMs / 1000} seconds`,
            );
        }
        if (arg === "--no-sync") noSync = true;
        if (arg === "--env") {
          const pair = value();
          const equal = pair.indexOf("=");
          const key = pair.slice(0, equal);
          if (equal < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error("--env expects K=V");
          env[key] = pair.slice(equal + 1);
        }
      } else if (["status", "log", "ps"].includes(arg) && !command) {
        command = arg === "ps" ? "exec" : arg;
        if (arg === "ps") {
          script = value();
          if (script === "-") script = await io.stdin();
          if (!script.length) throw new Error("PowerShell script is empty");
        }
      } else throw new Error(`unexpected argument: ${arg}`);
    }
    if (!command) throw new Error("a command is required (see --help)");
    if (command !== "exec" && execFlags.length)
      throw new Error(`${execFlags[0]} requires an exec command`);
    if (command !== "log" && hasLimit) throw new Error("-n requires log");
    if (command === "exec" && json) throw new Error("--json requires status or log");
  } catch (error) {
    return report(error instanceof Error ? error.message : String(error), 125);
  }
  if (!io.env.T3_WIN_ENDPOINT || !io.env.T3_WIN_CREDENTIAL_FILE)
    return report("UNAUTHORIZED: missing endpoint or credential file", 120);
  let token: string;
  try {
    token = (await io.readFile(io.env.T3_WIN_CREDENTIAL_FILE)).trim();
    if (!token) throw new Error("empty credential");
  } catch {
    return report("UNAUTHORIZED: cannot read credential file", 120);
  }
  const controller = new AbortController();
  let signalCode = 0;
  const off = Object.entries({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }).map(([signal, number]) =>
    io.onSignal(signal, () => {
      signalCode = 128 + number;
      controller.abort();
    }),
  );
  let accepted = false;
  try {
    const url = new URL(`${io.env.T3_WIN_ENDPOINT.replace(/\/$/, "")}/${command}`);
    if (command !== "exec") {
      if (host) url.searchParams.set("host", host);
      if (command === "log") url.searchParams.set("n", String(limit));
    }
    const response = await io.fetch(url, {
      method: command === "exec" ? "POST" : "GET",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(io.env.T3_WIN_LABEL ? { "x-t3-win-label": io.env.T3_WIN_LABEL } : {}),
      },
      ...(command === "exec"
        ? {
            body: JSON.stringify({
              ...(host ? { host } : {}),
              exec: {
                ...(argv.length ? { mode: "argv", argv } : { mode: "powershell", script }),
                serverCwd: io.cwd(),
                ...(winCwd ? { winCwd } : {}),
                env,
                timeoutMs,
                noSync,
              },
            }),
          }
        : {}),
    });
    if (response.status === 401) {
      const line = JSON.parse(await response.text());
      return report(`${line.code ?? "UNAUTHORIZED"}: ${line.message ?? "invalid credential"}`, 120);
    }
    if (!response.ok) return report(`HTTP ${response.status}`, 121);
    if (command !== "exec") {
      const text = await response.text();
      const body = JSON.parse(text);
      if (body.type === "error")
        return report(`${body.code}: ${body.message}`, io.constants.errorCodes[body.code] ?? 123);
      if (json) await io.stdout(text.endsWith("\n") ? text : `${text}\n`);
      else if (command === "status") {
        await io.stdout(`Windows hosts: ${body.hosts.length}\n`);
        for (const h of body.hosts)
          await io.stdout(
            `${h.hostName} (${h.hostId}): ${h.execEnabled ? "enabled" : "disabled"}${h.hostId === body.selectedHostId ? " [selected]" : ""}\n`,
          );
        if (body.hostStatus)
          await io.stdout(
            `Grant: ${body.hostStatus.grant}; running: ${body.hostStatus.running}; shells: ${body.hostStatus.shells.join(", ")}\n`,
          );
        if (body.hostStatusError) await io.stdout(`Status: ${body.hostStatusError}\n`);
      } else {
        await io.stdout(`Execution log (${body.source})\n`);
        for (const e of body.entries)
          await io.stdout(
            `${e.startedAt} ${e.requestId} ${e.outcome}${e.exitCode === null ? "" : ` (${e.exitCode})`} ${e.summary}\n`,
          );
      }
      return 0;
    }
    if (!response.body) return report("no Windows host available", 121);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const line = async (text: string): Promise<number | undefined> => {
      if (!text.trim()) return;
      const event = JSON.parse(text);
      if (event.type === "accepted") accepted = true;
      if (event.type === "stdout") await io.stdout(event.data);
      if (event.type === "stderr") await io.stderr(event.data);
      if (event.type === "progress" && event.progress.type === "awaiting-grant")
        await io.stderr("[win] waiting for Windows session approval\n");
      if (event.type === "progress" && event.progress.type === "truncated")
        await io.stderr("[win] output truncated\n");
      if (event.type === "error")
        return report(
          `${event.code}: ${event.message}`,
          io.constants.errorCodes[event.code] ?? 123,
        );
      if (event.type === "result") {
        const result: DesktopExecResult = event.result;
        const code =
          result.outcome === "exited"
            ? (result.exitCode ?? io.constants.resultCodes.unknown!)
            : io.constants.resultCodes[result.outcome]!;
        if (!Number.isInteger(code) || code < 0 || code > 255)
          return report(
            `remote exit code 0x${(code < 0 ? code >>> 0 : code).toString(16).toUpperCase()}`,
            1,
          );
        return code;
      }
    };
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const code = await line(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (code !== undefined) return code;
        }
        if (chunk.done) {
          const code = await line(buffer);
          if (code !== undefined) return code;
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return report(
      accepted ? "state unknown; check `win log`" : "no Windows host available",
      accepted ? 122 : 121,
    );
  } catch {
    if (signalCode) return report("cancelled", signalCode);
    return report(
      accepted ? "connection lost; state unknown; check `win log`" : "cannot connect to server",
      accepted ? 122 : 121,
    );
  } finally {
    for (const remove of off) remove();
  }
}
