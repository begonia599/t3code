// @effect-diagnostics nodeBuiltinImport:off -- Isolated native storage fixtures.
// @effect-diagnostics globalDate:off -- Deterministic durable timestamps in tests.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DESKTOP_EXEC_GRANT_WAIT_MS,
  type DesktopExecLogEntry,
  type RemoteControlGrantRequest,
} from "@t3tools/contracts";
import { createRemoteControlStore } from "./RemoteControlStore.ts";

let dir: string;
let store: Awaited<ReturnType<typeof createRemoteControlStore>>;
const input = {
  environmentId: "env",
  threadId: "thread",
  provider: "codex",
  label: null,
  mode: "argv" as const,
  summary: "node test",
  winCwd: "C:\\work",
  strictMode: false,
};
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-grants-test-"));
  store = await createRemoteControlStore({ stateDir: dir, now: () => Date.now() });
});
afterEach(async () => {
  store.rejectEnvironment();
  vi.useRealTimers();
  await NodeFSP.rm(dir, { recursive: true, force: true });
});
const authorize = (patch: Partial<typeof input> = {}, signal = new AbortController().signal) =>
  store.authorize({ ...input, ...patch }, signal, async () => {});
const id = () => store.getPendingGrantRequests()[0]!.grantRequestId;
const decide = (decision: "allow-session" | "allow-once" | "deny") =>
  store.resolveGrant({ grantRequestId: id(), decision });

describe("grants", () => {
  it("requests approval, persists a session grant, touches it and isolates environments", async () => {
    const wait = authorize();
    expect(store.getPendingGrantRequests()).toMatchObject([{ ...input, requestCount: 1 }]);
    await decide("allow-session");
    await wait;
    await authorize();
    expect(store.getPendingGrantRequests()).toEqual([]);
    const reopened = await createRemoteControlStore({ stateDir: dir });
    expect(reopened.grantState("env", "thread")).toBe("granted");
    expect(reopened.grantState("other", "thread")).toBe("none");
    expect(reopened.listGrants()).toMatchObject([{ provider: "codex", label: null }]);
    await store.revokeGrant({ environmentId: "env", threadId: "thread" });
    expect(store.grantState("env", "thread")).toBe("none");
  });
  it("requires approval for each strict request and forbids session grants", async () => {
    const first = authorize({ strictMode: true });
    await expect(decide("allow-session")).rejects.toThrow("strict mode");
    await decide("allow-once");
    await first;
    const second = authorize({ strictMode: true });
    expect(store.getPendingGrantRequests()).toHaveLength(1);
    await decide("allow-once");
    await second;
    expect(store.listGrants()).toEqual([]);
  });
  it("does not merge strict requests and never grants a threadless session", async () => {
    const first = authorize({ strictMode: true });
    const second = authorize({ strictMode: true });
    expect(store.getPendingGrantRequests()).toHaveLength(2);
    await decide("allow-once");
    await decide("allow-once");
    await Promise.all([first, second]);
    const wait = store.authorize(
      { ...input, threadId: null },
      new AbortController().signal,
      async () => {},
    );
    await expect(decide("allow-session")).rejects.toThrow("without a thread");
    await decide("allow-once");
    await wait;
  });
  it("remembers deny for ten minutes only in the same environment", async () => {
    vi.useFakeTimers();
    const wait = authorize();
    const rejection = expect(wait).rejects.toMatchObject({ code: "GRANT_DENIED" });
    await decide("deny");
    await rejection;
    await expect(authorize()).rejects.toMatchObject({ code: "GRANT_DENIED" });
    expect(store.grantState("other", "thread")).toBe("none");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const again = authorize();
    await decide("allow-once");
    await again;
  });
  it("expires unanswered grants and rejects expired or fabricated ids", async () => {
    vi.useFakeTimers();
    const wait = authorize();
    const expired = id();
    const rejection = expect(wait).rejects.toMatchObject({ code: "GRANT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(DESKTOP_EXEC_GRANT_WAIT_MS);
    await rejection;
    expect(store.getPendingGrantRequests()).toEqual([]);
    await expect(
      store.resolveGrant({ grantRequestId: expired, decision: "allow-once" }),
    ).rejects.toThrow("Unknown or expired");
    await expect(
      store.resolveGrant({ grantRequestId: "invented", decision: "allow-session" }),
    ).rejects.toThrow("Unknown or expired");
  });
  it("cancels pending requests, publishes full lists, and asks for attention", async () => {
    const lists: Array<readonly RemoteControlGrantRequest[]> = [];
    const publish = vi.fn((pending: readonly RemoteControlGrantRequest[]) => {
      lists.push(pending);
    });
    const attention = vi.fn();
    store = await createRemoteControlStore({
      stateDir: dir,
      onPendingChanged: publish,
      onAttention: attention,
    });
    const controller = new AbortController();
    const wait = authorize({}, controller.signal);
    const rejected = expect(wait).rejects.toMatchObject({ code: "CANCELLED" });
    controller.abort();
    await rejected;
    expect(attention).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0]).toHaveLength(1);
    expect(publish.mock.calls.at(-1)![0]).toEqual([]);
  });
  it("merges same-thread requests for session approval and removes cancelled waiters", async () => {
    const controller = new AbortController();
    const first = authorize({}, controller.signal);
    const second = authorize();
    expect(store.getPendingGrantRequests()).toMatchObject([{ requestCount: 2 }]);
    const rejected = expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    controller.abort();
    await rejected;
    expect(store.getPendingGrantRequests()).toMatchObject([{ requestCount: 1 }]);
    await decide("allow-session");
    await second;
  });
  it("allow-once releases only one merged command and rotates the pending id", async () => {
    const first = authorize();
    const second = authorize();
    const original = id();
    await decide("allow-once");
    await first;
    expect(id()).not.toBe(original);
    expect(store.getPendingGrantRequests()).toMatchObject([{ requestCount: 1 }]);
    await expect(
      store.resolveGrant({ grantRequestId: original, decision: "allow-once" }),
    ).rejects.toThrow();
    await decide("allow-once");
    await second;
  });
  it("rejects all pending requests when their environment is disabled", async () => {
    const first = authorize();
    const second = authorize({ threadId: "second" });
    const other = authorize({ environmentId: "other" });
    const rejections = Promise.all([
      expect(first).rejects.toMatchObject({ code: "GRANT_DENIED" }),
      expect(second).rejects.toMatchObject({ code: "GRANT_DENIED" }),
    ]);
    store.rejectEnvironment("env");
    await rejections;
    expect(store.getPendingGrantRequests()).toMatchObject([{ environmentId: "other" }]);
    await decide("allow-once");
    await other;
  });
  it("expires session grants after seven idle days", async () => {
    vi.useFakeTimers();
    const wait = authorize();
    await decide("allow-session");
    await wait;
    await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60_000);
    await authorize();
    await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60_000);
    expect(store.grantState("env", "thread")).toBe("granted");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(store.grantState("env", "thread")).toBe("none");
    expect((await createRemoteControlStore({ stateDir: dir })).listGrants()).toEqual([]);
  });
});

const audit = (i: number): DesktopExecLogEntry => ({
  requestId: `r${i}`,
  startedAt: new Date(i * 1000).toISOString(),
  finishedAt: null,
  threadId: "thread",
  provider: "codex",
  label: null,
  mode: "argv",
  summary: "node",
  winCwd: "C:\\work",
  outcome: "running",
  exitCode: null,
  errorCode: null,
  durationMs: null,
});
describe("audit", () => {
  it("appends, merges by id, orders newest first and ignores a crash-truncated row", async () => {
    await store.appendAudit(audit(1));
    await store.appendAudit(audit(2));
    await store.appendAudit({ ...audit(1), outcome: "exited", exitCode: 0 });
    const entries = await store.readAudit({ limit: 20 });
    expect(entries.map((e) => [e.requestId, e.outcome])).toEqual([
      ["r2", "running"],
      ["r1", "exited"],
    ]);
    const file = NodePath.join(dir, "remote-control-audit.jsonl");
    const raw = await NodeFSP.readFile(file, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
    await NodeFSP.writeFile(file, raw + '{"truncated":');
    expect(await store.readAudit({ limit: 1 })).toEqual([audit(2)]);
  });
  it("compacts more than 1000 rows to the latest 200 requests", async () => {
    const file = NodePath.join(dir, "remote-control-audit.jsonl");
    await NodeFSP.writeFile(
      file,
      Array.from({ length: 1000 }, (_, i) => JSON.stringify(audit(i))).join("\n") + "\n",
    );
    await store.appendAudit(audit(1000));
    expect((await NodeFSP.readFile(file, "utf8")).trim().split("\n")).toHaveLength(200);
    const entries = await store.readAudit({ limit: 1000 });
    expect(entries[0]?.requestId).toBe("r1000");
    expect(entries.at(-1)?.requestId).toBe("r801");
  });
  it("does not fail execution on audit I/O errors", async () => {
    await NodeFSP.rm(dir, { recursive: true });
    await NodeFSP.writeFile(dir, "not a directory");
    await expect(store.appendAudit(audit(1))).resolves.toBeUndefined();
  });
});
