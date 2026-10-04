import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  clearMcpProviderSession,
  readMcpProviderSession,
  setMcpProviderSession,
  withAgentDeviceEnvironment,
} from "./McpProviderSession.ts";

it("routes a sandbox MCP endpoint without changing its credential or another session's URL", () => {
  const threadId = ThreadId.make("sandbox-mcp-test");
  const config = {
    threadId,
    environmentId: EnvironmentId.make("test-environment"),
    providerInstanceId: ProviderInstanceId.make("claude-personal"),
    providerSessionId: "session-fixture",
    endpoint: "http://127.0.0.1:3000/mcp",
    authorizationHeader: "Bearer scoped-fixture",
    capabilities: new Set(["preview"]),
  };
  setMcpProviderSession(config);
  try {
    expect(readMcpProviderSession(threadId, "10.231.1.1")).toMatchObject({
      endpoint: "http://10.231.1.1:3000/mcp",
      authorizationHeader: config.authorizationHeader,
    });
    expect(readMcpProviderSession(threadId)).toBe(config);
  } finally {
    clearMcpProviderSession(threadId);
  }
});

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});
