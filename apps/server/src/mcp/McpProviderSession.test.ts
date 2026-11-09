import { describe, expect, it } from "vite-plus/test";
import { withAgentDeviceEnvironment } from "./McpProviderSession.ts";

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

it("prepends both win and device paths while preserving provider variables", () => {
  expect(
    withAgentDeviceEnvironment(
      { PATH: "/provider:/usr/bin", KEY: "provider" },
      {
        agentDeviceEnvironment: { PATH: "/device", AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
        agentWinEnvironment: {
          PATH: "/win",
          T3_WIN_ENDPOINT: "http://localhost/agent-win/v1",
          T3_WIN_CREDENTIAL_FILE: "/token",
        },
      },
    ),
  ).toEqual({
    PATH: "/win:/device:/provider:/usr/bin",
    KEY: "provider",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    T3_WIN_ENDPOINT: "http://localhost/agent-win/v1",
    T3_WIN_CREDENTIAL_FILE: "/token",
  });
});
it("merges Windows Path using the device separator for both shims", () => {
  expect(
    withAgentDeviceEnvironment(
      { Path: "C:\\provider" },
      {
        agentDeviceEnvironment: { PATH: "C:\\device", PATH_SEPARATOR: ";" },
        agentWinEnvironment: { PATH: "C:\\win" },
      },
    ).PATH,
  ).toBe("C:\\win;C:\\device;C:\\provider");
});
