// @effect-diagnostics globalDate:off -- Audit timestamps are recorded at the native Promise request boundary.
import { DesktopMcpCallInput, type DesktopExecLogEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { LocalMcpError, type LocalMcpManager } from "./LocalMcpManager.ts";
import type { RequestHandler } from "./RemoteControlRequestRouter.ts";
import type { RemoteControlStore } from "./RemoteControlStore.ts";

const decodeInput = Schema.decodeUnknownSync(DesktopMcpCallInput);

export function createLocalMcpRequestHandler(options: {
  readonly manager: Pick<LocalMcpManager["Service"], "call">;
  readonly enabledEnvironmentIds: () => Promise<readonly string[]>;
  readonly store: Pick<RemoteControlStore["Service"], "appendAudit">;
}): RequestHandler {
  return async ({ request, environmentId, signal, emit }) => {
    const started = Date.now();
    let entry: DesktopExecLogEntry = {
      requestId: request.requestId,
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      threadId: request.context.threadId ?? null,
      provider: request.context.provider ?? null,
      label: request.context.label ?? null,
      mode: "mcp",
      summary: "Invalid MCP input",
      winCwd: null,
      exitCode: null,
      outcome: "running",
      errorCode: null,
      durationMs: null,
    };
    try {
      let input: DesktopMcpCallInput;
      try {
        input = decodeInput(request.input);
      } catch (cause) {
        throw new LocalMcpError("BAD_REQUEST", `Invalid MCP call: ${String(cause)}`);
      }
      entry = { ...entry, summary: `${input.serverId}__${input.toolName}` };
      if (!(await options.enabledEnvironmentIds()).includes(environmentId))
        throw new LocalMcpError(
          "REMOTE_DISABLED",
          "Remote control is disabled for this environment",
        );
      const result = await options.manager.call(
        input.serverId,
        input.toolName,
        input.arguments,
        signal,
        (progress) => emit({ kind: "progress", data: JSON.stringify(progress) }),
      );
      entry = { ...entry, outcome: "exited" };
      return result;
    } catch (cause) {
      const code = signal.aborted
        ? "CANCELLED"
        : cause instanceof LocalMcpError
          ? cause.code
          : "MCP_PROTOCOL_ERROR";
      entry = {
        ...entry,
        errorCode: code,
        outcome: code === "CANCELLED" ? "cancelled" : code === "TIMEOUT" ? "timedOut" : "error",
      };
      throw new LocalMcpError(code, cause instanceof Error ? cause.message : String(cause));
    } finally {
      await options.store.appendAudit({
        ...entry,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
    }
  };
}
