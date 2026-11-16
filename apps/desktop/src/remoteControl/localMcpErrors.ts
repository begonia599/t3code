// @effect-diagnostics nodeBuiltinImport:off -- Native HTTP status descriptions at the SDK adapter boundary.
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { LocalMcpErrorKind } from "@t3tools/contracts";
import * as NodeHttp from "node:http";

export interface LocalMcpErrorContext {
  readonly transport: "stdio" | "http";
  readonly connected: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Expand native fetch/aggregate causes without losing the original SDK message. */
export function classifyLocalMcpError(
  cause: unknown,
  context: LocalMcpErrorContext,
): { kind: LocalMcpErrorKind; detail: string } {
  const seen = new Set<unknown>();
  const errors: Record<string, unknown>[] = [];
  const describe = (value: unknown): string => {
    if (seen.has(value)) return "";
    seen.add(value);
    const error = record(value);
    errors.push(error);
    let detail = typeof error.message === "string" ? error.message : String(value);
    if (typeof error.code === "string" && !detail.includes(error.code)) {
      detail += ` (${error.code})`;
    }
    if (typeof error.address === "string" && !detail.includes(error.address)) {
      detail += ` ${error.address}${error.port === undefined ? "" : `:${String(error.port)}`}`;
    }
    const nested = [
      ...(error.cause === undefined ? [] : [error.cause]),
      ...(Array.isArray(error.errors) ? error.errors : []),
    ]
      .map(describe)
      .filter(Boolean);
    return `${detail}${nested.length ? ` (${nested.join("; ")})` : ""}`;
  };
  let detail = describe(cause);
  const hasCode = (...codes: Array<string | number>) =>
    errors.some((error) => codes.includes(error.code as string | number));
  if (
    hasCode(
      "TIMEOUT",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "ABORT_ERR",
      ErrorCode.RequestTimeout,
    ) ||
    errors.some((error) => error.name === "TimeoutError")
  ) {
    return { kind: "timeout", detail };
  }
  const status = errors
    .map(
      (error) =>
        error.status ??
        error.statusCode ??
        (error instanceof StreamableHTTPError ? error.code : undefined),
    )
    .find((value): value is number => typeof value === "number" && value >= 100 && value <= 599);
  if (status !== undefined) {
    detail = `HTTP ${status}${NodeHttp.STATUS_CODES[status] ? ` ${NodeHttp.STATUS_CODES[status]}` : ""}: ${detail}`;
    return { kind: "http", detail };
  }
  const disconnected =
    hasCode(ErrorCode.ConnectionClosed) ||
    /connection closed|transport closed|SSE stream disconnected/i.test(detail);
  if (
    context.transport === "stdio" &&
    (hasCode("ENOENT", "EACCES") || (!context.connected && disconnected))
  ) {
    return { kind: "spawn", detail };
  }
  if (context.connected && (disconnected || hasCode("ECONNRESET", "EPIPE", "UND_ERR_SOCKET"))) {
    return { kind: "closed", detail };
  }
  if (
    hasCode(
      "ECONNREFUSED",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ECONNRESET",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
    ) ||
    (context.transport === "http" && /fetch failed/i.test(detail))
  ) {
    return { kind: "unreachable", detail };
  }
  return { kind: "protocol", detail };
}
