import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the session credential grants, including optional device and win access. */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** The Windows launcher PATH and session credential file, when win access is granted. */
  readonly agentWinEnvironment?: Readonly<Record<string, string>>;
}

/** Prepends both launcher directories and applies their variables; otherwise returns `base`. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | Pick<McpProviderSessionConfig, "agentDeviceEnvironment" | "agentWinEnvironment">
    | undefined,
): NodeJS.ProcessEnv {
  const extras = [config?.agentDeviceEnvironment, config?.agentWinEnvironment].filter(
    (extra) => extra !== undefined,
  );
  if (!extras.length) return base;
  const environment = { ...base };
  const separator =
    config?.agentWinEnvironment?.PATH_SEPARATOR ??
    config?.agentDeviceEnvironment?.PATH_SEPARATOR ??
    ":";
  for (const extra of extras) {
    const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
    const basePath = environment.PATH ?? environment.Path;
    Object.assign(environment, rest);
    if (shimDir) environment.PATH = basePath ? `${shimDir}${separator}${basePath}` : shimDir;
  }
  return environment;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
