import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopExecInput,
  DesktopExecProgress,
  DesktopExecResult,
  WinGatewayExecRequest,
  WinGatewayExecLine,
  WinGatewayStatusResponse,
  WinGatewayLogResponse,
  DESKTOP_EXEC_MAX_TIMEOUT_MS,
  DesktopExecErrorCode,
  WinGatewayErrorCode,
  winExitCodeForError,
  winExitCodeForResult,
} from "./desktopExec.ts";
import { ServerSettings, ProjectSettingsOverrides } from "./settings.ts";

const decodeExec = Schema.decodeUnknownSync(DesktopExecInput, { onExcessProperty: "error" });
const decodeRequest = Schema.decodeUnknownSync(WinGatewayExecRequest);
const decodeProgress = Schema.decodeUnknownSync(DesktopExecProgress);
const decodeResult = Schema.decodeUnknownSync(DesktopExecResult);
const decodeLine = Schema.decodeUnknownSync(WinGatewayExecLine);
const decodeStatus = Schema.decodeUnknownSync(WinGatewayStatusResponse);
const decodeLog = Schema.decodeUnknownSync(WinGatewayLogResponse);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeOverrides = Schema.decodeUnknownSync(ProjectSettingsOverrides);
const input = {
  mode: "argv",
  argv: ["echo", "a b"],
  serverCwd: "/project",
  env: { KEY: "value" },
  timeoutMs: 600000,
  noSync: false,
};
const result = {
  outcome: "exited",
  exitCode: 0,
  durationMs: 1,
  winCwd: "C:\\project",
  stdoutBytes: 1,
  stderrBytes: 0,
  truncated: false,
  decodedAsGbk: false,
} as const;

describe("desktop exec contracts", () => {
  it("decodes argv, PowerShell and the HTTP envelope", () => {
    expect(decodeExec(input)).toEqual(input);
    const { argv: _argv, ...common } = input;
    expect(decodeExec({ ...common, mode: "powershell", script: "Write-Host hi" })).toMatchObject({
      mode: "powershell",
      script: "Write-Host hi",
    });
    expect(decodeRequest({ exec: input, host: "Windows" })).toMatchObject({ host: "Windows" });
  });
  it.each([
    { ...input, argv: [] },
    { ...input, env: { "bad-key": "x" } },
    { ...input, timeoutMs: 0 },
    { ...input, timeoutMs: DESKTOP_EXEC_MAX_TIMEOUT_MS + 1 },
    { ...input, serverCwd: "" },
  ])("rejects invalid exec input %#", (value) => {
    expect(() => decodeExec(value)).toThrow();
  });
  it("decodes progress and terminal HTTP lines and rejects unknown progress", () => {
    expect(decodeProgress({ type: "awaiting-grant" })).toEqual({ type: "awaiting-grant" });
    expect(decodeLine({ type: "result", result })).toEqual({ type: "result", result });
    expect(() => decodeProgress({ type: "unknown" })).toThrow();
    expect(() => decodeResult({ ...result, durationMs: -1 })).toThrow();
    expect(
      decodeStatus({
        threadId: null,
        provider: null,
        hosts: [],
        selectedHostId: null,
        hostStatus: null,
        hostStatusError: "HOST_OFFLINE",
      }).hosts,
    ).toEqual([]);
    expect(decodeLog({ source: "server", entries: [] })).toEqual({ source: "server", entries: [] });
  });
  it("maps every declared launcher error", () => {
    const groups: Record<number, readonly string[]> = {
      120: ["UNAUTHORIZED"],
      121: [
        "HOST_OFFLINE",
        "HOST_AMBIGUOUS",
        "HOST_NOT_FOUND",
        "HOST_DISABLED",
        "HOST_BUSY",
        "REMOTE_DISABLED",
      ],
      122: ["HOST_DISCONNECTED"],
      124: ["TIMEOUT"],
      125: ["BAD_REQUEST"],
      126: ["GRANT_DENIED", "GRANT_TIMEOUT"],
      127: ["SPAWN_NOT_FOUND"],
      130: ["CANCELLED"],
    };
    for (const code of [
      ...DesktopExecErrorCode.literals,
      ...WinGatewayErrorCode.literals,
      "future-code",
    ]) {
      const expected = Object.entries(groups).find(([, names]) => names.includes(code))?.[0];
      expect(winExitCodeForError(code)).toBe(expected ? Number(expected) : 123);
    }
    expect(winExitCodeForResult(result)).toBe(0);
    expect(winExitCodeForResult({ ...result, outcome: "timedOut" })).toBe(124);
    expect(winExitCodeForResult({ ...result, outcome: "cancelled" })).toBe(130);
    expect(winExitCodeForResult({ ...result, exitCode: null })).toBe(122);
    expect(winExitCodeForResult({ ...result, exitCode: 0xc0000005 })).toBe(0xc0000005);
  });
  it("defaults win access off and supports independent project overrides", () => {
    expect(decodeSettings({}).enableAgentWinAccess).toBe(false);
    expect(decodeOverrides({ enableAgentWinAccess: true }).enableAgentWinAccess).toBe(true);
    expect(decodeOverrides({})).not.toHaveProperty("enableAgentWinAccess");
  });
});
