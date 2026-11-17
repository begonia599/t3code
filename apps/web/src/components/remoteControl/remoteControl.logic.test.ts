import type { DesktopExecLogEntry, RemoteControlGrantRequest } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  bridgeErrorMessage,
  describeExecOutcome,
  describeExecReason,
  formatCountdown,
  formatDuration,
  isPosixAbsolutePath,
  isWindowsAbsolutePath,
  orderGrantRequests,
  providerLabel,
  splitMcpSummary,
} from "./remoteControl.logic";

const entry = (overrides: Partial<DesktopExecLogEntry>): DesktopExecLogEntry => ({
  requestId: "request-1",
  startedAt: "2026-11-09T10:00:00.000Z",
  finishedAt: null,
  threadId: null,
  provider: null,
  label: null,
  mode: "argv",
  summary: "cmd /c ver",
  winCwd: null,
  outcome: "exited",
  exitCode: 0,
  errorCode: null,
  durationMs: null,
  ...overrides,
});

const request = (grantRequestId: string, requestedAt: string): RemoteControlGrantRequest => ({
  grantRequestId,
  environmentId: "environment-1",
  threadId: "thread-1",
  provider: "codex",
  label: null,
  mode: "argv",
  summary: "cmd /c ver",
  winCwd: "D:\\Projects",
  strictMode: false,
  requestedAt,
  expiresAt: "2026-11-09T10:05:00.000Z",
  requestCount: 1,
});

describe("remote control paths", () => {
  it("accepts drive and UNC paths as Windows absolute paths", () => {
    assert.isTrue(isWindowsAbsolutePath("D:\\Projects"));
    assert.isTrue(isWindowsAbsolutePath("c:/work"));
    assert.isTrue(isWindowsAbsolutePath("\\\\nas\\share\\game"));
    assert.isFalse(isWindowsAbsolutePath("D:"));
    assert.isFalse(isWindowsAbsolutePath("Projects\\game"));
    assert.isFalse(isWindowsAbsolutePath("\\\\nas"));
    assert.isFalse(isWindowsAbsolutePath("/home/dev"));
  });

  it("requires server paths to be POSIX absolute", () => {
    assert.isTrue(isPosixAbsolutePath("/home/dev/project"));
    assert.isFalse(isPosixAbsolutePath("home/dev"));
    assert.isFalse(isPosixAbsolutePath("D:\\Projects"));
  });
});

describe("remote control formatting", () => {
  it("strips Electron's IPC prefix from rejected calls", () => {
    assert.equal(
      bridgeErrorMessage(
        new Error(
          "Error invoking remote method 'desktop:remote-control-update-config': Error: Folder must be absolute",
        ),
      ),
      "Folder must be absolute",
    );
    assert.equal(bridgeErrorMessage(new Error("plain")), "plain");
  });

  it("counts down in minutes and seconds without going negative", () => {
    assert.equal(formatCountdown(125_000, 0), "2:05");
    assert.equal(formatCountdown(1_200, 0), "0:02");
    assert.equal(formatCountdown(0, 5_000), "0:00");
  });

  it("formats durations at a readable precision", () => {
    assert.equal(formatDuration(820), "820 ms");
    assert.equal(formatDuration(3_420), "3.4 s");
    assert.equal(formatDuration(42_000), "42 s");
    assert.equal(formatDuration(125_000), "2m 05s");
  });

  it("names known providers and passes others through", () => {
    assert.equal(providerLabel("claudeAgent"), "Claude");
    assert.equal(providerLabel("codex"), "Codex");
    assert.equal(providerLabel("grok"), "grok");
    assert.isNull(providerLabel(null));
  });

  it("orders grant requests oldest first", () => {
    const ordered = orderGrantRequests([
      request("b", "2026-11-09T10:00:02.000Z"),
      request("a", "2026-11-09T10:00:01.000Z"),
      request("c", "2026-11-09T10:00:02.000Z"),
    ]);
    assert.deepEqual(
      ordered.map((item) => item.grantRequestId),
      ["a", "b", "c"],
    );
  });

  it("describes each audit outcome", () => {
    assert.deepEqual(describeExecOutcome(entry({})), {
      label: "Exit 0",
      tone: "success",
      code: null,
    });
    assert.deepEqual(describeExecOutcome(entry({ exitCode: 2 })), {
      label: "Exit {code}",
      tone: "warning",
      code: "2",
    });
    assert.deepEqual(
      describeExecOutcome(entry({ outcome: "error", exitCode: null, errorCode: "GRANT_DENIED" })),
      { label: "Error", tone: "error", code: null },
    );
    assert.equal(describeExecOutcome(entry({ outcome: "timedOut" })).label, "Timed out");
    assert.equal(describeExecOutcome(entry({ outcome: "running" })).tone, "info");
    assert.deepEqual(
      describeExecOutcome(
        entry({ outcome: "unknown", exitCode: null, errorCode: "HOST_DISCONNECTED" }),
      ),
      { label: "Unknown", tone: "warning", code: null },
    );
  });

  it("describes MCP tool calls without exit codes", () => {
    const mcp = { mode: "mcp" as const, summary: "unity__manage_scene", exitCode: null };
    assert.deepEqual(describeExecOutcome(entry(mcp)), {
      label: "Done",
      tone: "success",
      code: null,
    });
    assert.deepEqual(describeExecOutcome(entry({ ...mcp, errorCode: "MCP_TOOL_ERROR" })), {
      label: "Tool error",
      tone: "warning",
      code: null,
    });
    assert.deepEqual(splitMcpSummary("unity__manage_scene"), {
      server: "unity",
      tool: "manage_scene",
    });
    assert.deepEqual(splitMcpSummary("my_server__get__thing"), {
      server: "my_server",
      tool: "get__thing",
    });
    assert.isNull(splitMcpSummary("plain"));
    assert.isNull(splitMcpSummary("__tool"));
    assert.isNull(splitMcpSummary("server__"));
  });

  it("explains why a result is unknown and keeps raw error codes", () => {
    const unknown = (errorCode: string | null) =>
      describeExecReason(entry({ outcome: "unknown", exitCode: null, errorCode }));
    assert.deepEqual(unknown("SERVER_RESTARTED"), {
      text: "Server restarted mid-run",
      translate: true,
    });
    assert.deepEqual(unknown("CLEANUP_FAILED"), {
      text: "Process didn't shut down cleanly",
      translate: true,
    });
    assert.deepEqual(unknown("SOMETHING_NEW"), { text: "SOMETHING_NEW", translate: false });
    assert.isNull(unknown(null));
    assert.deepEqual(
      describeExecReason(entry({ outcome: "error", exitCode: null, errorCode: "GRANT_DENIED" })),
      { text: "GRANT_DENIED", translate: false },
    );
    assert.isNull(describeExecReason(entry({})));
    assert.isNull(
      describeExecReason(entry({ mode: "mcp", exitCode: null, errorCode: "MCP_TOOL_ERROR" })),
    );
  });
});
