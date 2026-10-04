import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { hostedMcpServers } from "./HostedMcp.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Local shell bridge only; never accepted as an HTTP MCP credential. */
  readonly credentialBridgeAuthorization?: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  readonly hostedServers?: ReadonlyArray<{ readonly name: string; readonly endpoint: string }>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | (Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> &
        Partial<Pick<McpProviderSessionConfig, "credentialBridgeAuthorization">>)
    | undefined,
): NodeJS.ProcessEnv {
  if (base.T3_CREDENTIAL_SOCKET && config?.credentialBridgeAuthorization) {
    base = { ...base, T3_CREDENTIAL_AUTHORIZATION: config.credentialBridgeAuthorization };
  }
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();
const providerFileRoots = new Map<ProviderInstanceId, ReadonlyArray<string>>();
const providerCredentialSockets = new Map<
  ProviderInstanceId,
  { socket: string; mcpHost?: string }
>();
const sessionDisposers = new Set<(sessionId: string) => Promise<void>>();
export function registerMcpSessionDisposer(
  dispose: (sessionId: string) => Promise<void>,
): () => void {
  sessionDisposers.add(dispose);
  return () => sessionDisposers.delete(dispose);
}
export async function disposeMcpSession(sessionId: string): Promise<void> {
  await Promise.allSettled([...sessionDisposers].map((dispose) => dispose(sessionId)));
}

export function registerProviderCredentialSocket(
  instanceId: ProviderInstanceId,
  socket: string,
  mcpHost?: string,
): () => void {
  const entry = { socket, ...(mcpHost ? { mcpHost } : {}) };
  providerCredentialSockets.set(instanceId, entry);
  return () => {
    if (providerCredentialSockets.get(instanceId) === entry)
      providerCredentialSockets.delete(instanceId);
  };
}
export function readProviderCredentialSocket(instanceId: ProviderInstanceId): string | undefined {
  return providerCredentialSockets.get(instanceId)?.socket;
}

export function readProviderMcpHost(instanceId: ProviderInstanceId): string | undefined {
  return providerCredentialSockets.get(instanceId)?.mcpHost;
}

/** Captured by MCP credentials; a profile replacement invalidates the old view. */
export function registerProviderFileRoots(
  instanceId: ProviderInstanceId,
  roots: ReadonlyArray<string>,
): () => void {
  providerFileRoots.set(instanceId, roots);
  return () => {
    if (providerFileRoots.get(instanceId) === roots) providerFileRoots.delete(instanceId);
  };
}

export function readProviderFileRoots(
  instanceId: ProviderInstanceId,
): ReadonlyArray<string> | undefined {
  return providerFileRoots.get(instanceId);
}

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(
  threadId: ThreadId,
  mcpHost?: string,
): McpProviderSessionConfig | undefined {
  const session = sessionsByThread.get(threadId);
  if (!session) return session;
  const hosted = hostedMcpServers(session.providerInstanceId);
  if (!mcpHost && hosted.length === 0) return session;
  const endpoint = new URL(session.endpoint);
  if (mcpHost) endpoint.hostname = mcpHost;
  return {
    ...session,
    endpoint: endpoint.toString(),
    ...(hosted.length
      ? {
          hostedServers: hosted.map((config) => ({
            name: `t3-hosted-${config.id}`,
            endpoint: new URL(`/mcp/hosted/${config.id}`, endpoint).toString(),
          })),
        }
      : {}),
  };
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
