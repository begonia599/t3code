import * as NodeCrypto from "node:crypto";
import {
  DESKTOP_MCP_CALL_KIND,
  DESKTOP_MCP_CALL_TIMEOUT_MS,
  DESKTOP_MCP_MAX_CONCURRENT_CALLS,
  DesktopMcpProgress,
  WIN_MCP_SERVER_NAME,
  WIN_MCP_TOOL_SEPARATOR,
  type DesktopChannelHost,
  type DesktopChannelRequestContext,
  type LocalMcpTool,
} from "@t3tools/contracts";
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as DesktopChannelBroker from "./DesktopChannelBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as DesktopLinkService from "../desktopLink/DesktopLinkService.ts";
import { resolveWindowsContext, windowsHostCandidates } from "./windowsHostContext.ts";

interface Catalog {
  tools: Tool[];
  targets: Map<string, { serverId: string; toolName: string }>;
  fingerprint: string;
}
export interface WinMcpSession {
  hostId?: string;
  hostName?: string;
  readonly context: DesktopChannelRequestContext;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Canonical object keys make a reordered schema or capabilities report a no-op.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)))
      : item,
  );
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const maxNameLength = 64 - `mcp__${WIN_MCP_SERVER_NAME}__`.length;

function catalogFor(
  servers: readonly { id: string; name: string; tools: readonly LocalMcpTool[] }[],
): Catalog {
  const tools: Tool[] = [];
  const targets = new Map<string, { serverId: string; toolName: string }>();
  const entries = servers
    .flatMap((server) => server.tools.map((tool) => ({ server, tool })))
    .sort((a, b) =>
      compare(
        canonical([a.server.id, a.tool.name, a.tool]),
        canonical([b.server.id, b.tool.name, b.tool]),
      ),
    );
  for (const { server, tool } of entries) {
    const prefix = `${server.id}${WIN_MCP_TOOL_SEPARATOR}`;
    const original = `${prefix}${tool.name}`;
    // Model APIs only accept [A-Za-z0-9_-]; a cleaned name always gets a hash so `a.b` and `a_b` stay distinct.
    const cleaned = tool.name.replace(/[^A-Za-z0-9_-]/g, "_");
    let name = `${prefix}${cleaned}`;
    let attempt = 0;
    // Retrying a hash with a deterministic salt also handles collisions with natural names.
    while (cleaned !== tool.name || name.length > maxNameLength || targets.has(name)) {
      const suffix = `_${hash(attempt === 0 ? original : `${original}:${attempt}`).slice(0, 6)}`;
      name = `${prefix}${cleaned.slice(0, maxNameLength - prefix.length - suffix.length)}${suffix}`;
      attempt++;
      if (!targets.has(name)) break;
    }
    const definition = {
      ...tool,
      name,
      description: `[Windows · ${server.name}] ${tool.description ?? ""}`,
    };
    if (!ToolSchema.safeParse(definition).success) continue;
    // Validate without using Zod's stripped output: local annotations may have extensions.
    tools.push(definition as Tool);
    targets.set(name, { serverId: server.id, toolName: tool.name });
  }
  return { tools, targets, fingerprint: hash(canonical(tools)) };
}
const emptyCatalog = catalogFor([]);
const failure = (code: string, hostName: string, detail = ""): CallToolResult => {
  const host = hostName === "" ? "" : ` ${hostName} `;
  const messages: Record<string, string> = {
    HOST_OFFLINE: `Windows 电脑${host}不在线，请在那台电脑上打开 T3 Code 桌面版。`,
    HOST_DISCONNECTED: `Windows 电脑${host}不在线，请在那台电脑上打开 T3 Code 桌面版。`,
    HOST_REPLACED: `Windows 电脑${host}连接已更换，调用结果未知，请检查后再试。`,
    HOST_DISABLED: `Windows 电脑${host}关闭了远程操作，请在那台电脑的 T3 Code 设置里打开远程操作。`,
    REMOTE_DISABLED: `Windows 电脑${host}关闭了远程操作，请在那台电脑的 T3 Code 设置里打开远程操作。`,
    HOST_AMBIGUOUS: "有多台 Windows 电脑提供 MCP，请先将项目关联到要使用的电脑。",
    TIMEOUT: "Windows MCP 调用超时（含排队时间），已请求取消；请检查本机工具状态。",
    CANCELLED: "Windows MCP 调用已取消。",
    BAD_REQUEST: "Windows MCP 调用参数不合法。",
    MCP_SERVER_NOT_FOUND: "Windows 电脑上找不到这个 MCP 服务，请检查本机 MCP 设置。",
    MCP_SERVER_DISABLED: "Windows 电脑上的这个 MCP 服务已停用，请在本机 MCP 设置中启用。",
    MCP_SERVER_UNAVAILABLE: `Windows 电脑${host}上的 MCP 服务暂时不可用（可能没启动或正在重启），几秒后重试；一直失败请在 T3 桌面版「本机 MCP 服务器」里查看状态。`,
    MCP_TOOL_NOT_FOUND: "Windows MCP 工具不存在，请重新加载工具目录。",
    MCP_PROTOCOL_ERROR: "Windows MCP 服务返回了协议错误。",
    MCP_RESULT_TOO_LARGE: "Windows MCP 工具结果过大，请缩小查询范围后重试。",
    HOST_BUSY: "Windows 电脑正忙，请稍后重试。",
  };
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `[${code}] ${messages[code] ?? "Windows MCP 调用失败。"}${detail ? `\n${detail}` : ""}`,
      },
    ],
  };
};
const decodeProgress = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopMcpProgress));

export class WinMcpRelay extends Context.Service<
  WinMcpRelay,
  {
    readonly open: (scope: McpInvocationScope, label?: string) => Effect.Effect<WinMcpSession>;
    readonly list: (session: WinMcpSession) => Effect.Effect<Catalog>;
    readonly changes: Stream.Stream<DesktopChannelHost>;
    readonly call: (
      session: WinMcpSession,
      name: string,
      args: Record<string, unknown> | undefined,
      progress?: (value: DesktopMcpProgress) => Promise<void>,
    ) => Effect.Effect<CallToolResult>;
  }
>()("t3/desktopChannel/WinMcpRelay") {}

const make = Effect.gen(function* () {
  const broker = yield* DesktopChannelBroker.DesktopChannelBroker;
  const services = yield* Effect.context<
    ProjectionSnapshotQuery | DesktopLinkService.DesktopLinkService
  >();
  const catalogs = new Map<
    string,
    {
      servers: Map<string, { id: string; name: string; tools: readonly LocalMcpTool[] }>;
      catalog: Catalog;
      source: DesktopChannelHost["capabilities"]["mcp"];
    }
  >();
  const limits = new Map<string, Semaphore.Semaphore>();
  const refresh = (host: DesktopChannelHost) => {
    const previous = catalogs.get(host.hostId);
    if (previous && previous.source === host.capabilities.mcp) return previous.catalog;
    const servers = new Map<string, { id: string; name: string; tools: readonly LocalMcpTool[] }>();
    for (const server of host.capabilities.mcp?.servers ?? []) {
      servers.set(
        server.id,
        server.status === "failed" && previous?.servers.has(server.id)
          ? previous.servers.get(server.id)!
          : server,
      );
    }
    const catalog = catalogFor([...servers.values()]);
    catalogs.set(host.hostId, { servers, catalog, source: host.capabilities.mcp });
    return catalog;
  };
  const changes = yield* PubSub.unbounded<DesktopChannelHost>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  yield* Stream.runForEach(broker.hostChanges, (host) =>
    Effect.sync(() => {
      refresh(host);
      PubSub.publishUnsafe(changes, host);
    }),
  ).pipe(Effect.forkScoped);
  const list = Effect.fn("WinMcpRelay.list")(function* (session: WinMcpSession) {
    const hosts = yield* broker.listKnownHosts();
    if (!session.hostId) {
      const candidates = windowsHostCandidates(
        hosts,
        undefined,
        session.context.linkedHostId,
        (host) => host.capabilities.mcp !== undefined,
      );
      if (candidates.length === 1) session.hostId = candidates[0]!.hostId;
    }
    const host = hosts.find((host) => host.hostId === session.hostId);
    if (!host) return emptyCatalog;
    session.hostName = host.hostName;
    return refresh(host);
  });
  const open = Effect.fn("WinMcpRelay.open")(function* (scope: McpInvocationScope, label?: string) {
    const { context, link } = yield* resolveWindowsContext(scope, label).pipe(
      Effect.provide(services),
      Effect.orDie,
    );
    const session: WinMcpSession = {
      context,
      ...(link ? { hostId: link.hostId, hostName: link.hostName } : {}),
    };
    yield* list(session);
    return session;
  });
  const call: WinMcpRelay["Service"]["call"] = (session, name, args, progress) =>
    Effect.gen(function* () {
      const catalog = yield* list(session);
      if (!session.hostId) {
        const hosts = yield* broker.listKnownHosts();
        return failure(
          hosts.filter((host) => host.capabilities.mcp).length > 1
            ? "HOST_AMBIGUOUS"
            : "HOST_OFFLINE",
          "",
        );
      }
      const hostId = session.hostId;
      const target = catalog.targets.get(name);
      if (!target) return failure("MCP_TOOL_NOT_FOUND", session.hostName ?? hostId, name);
      let limit = limits.get(hostId);
      if (!limit) {
        limit = Semaphore.makeUnsafe(DESKTOP_MCP_MAX_CONCURRENT_CALLS);
        limits.set(hostId, limit);
      }
      return yield* limit
        .withPermits(1)(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* broker.invoke({
                hostId,
                kind: DESKTOP_MCP_CALL_KIND,
                input: { ...target, ...(args === undefined ? {} : { arguments: args }) },
                timeoutMs: DESKTOP_MCP_CALL_TIMEOUT_MS + 2_000,
                context: session.context,
              });
              const events = yield* Stream.runForEach(handle.events, (batch) =>
                Effect.gen(function* () {
                  if (!progress) return;
                  for (const event of batch.events) {
                    if (event.kind !== "progress") continue;
                    const decoded = decodeProgress(event.data);
                    if (decoded._tag === "Some")
                      yield* Effect.tryPromise(() => progress(decoded.value)).pipe(Effect.ignore);
                  }
                }),
              ).pipe(Effect.forkScoped);
              const result = yield* handle.result;
              yield* Fiber.join(events);
              // Preserve extension fields on content blocks as well as top-level result metadata.
              return CallToolResultSchema.safeParse(result).success
                ? (result as CallToolResult)
                : failure(
                    "MCP_PROTOCOL_ERROR",
                    session.hostName ?? hostId,
                    "Invalid CallToolResult",
                  );
            }),
          ),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.succeed(
              failure(error.remoteCode ?? error.code, session.hostName ?? hostId, error.message),
            ),
          ),
          Effect.timeoutOrElse({
            duration: DESKTOP_MCP_CALL_TIMEOUT_MS + 2_000,
            orElse: () => Effect.succeed(failure("TIMEOUT", session.hostName ?? hostId)),
          }),
        );
    });
  return WinMcpRelay.of({ open, list, call, changes: Stream.fromPubSub(changes) });
});
export const layer = Layer.effect(WinMcpRelay, make);
