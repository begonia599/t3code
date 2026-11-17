import * as NodePerfHooks from "node:perf_hooks";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Audit from "./DesktopChannelAudit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const entry = {
  requestId: "request",
  hostId: "host",
  hostName: "PC",
  serverCwd: "/project",
  threadId: "thread",
  provider: "codex",
  label: null,
  mode: "mcp",
  summary: "x".repeat(600),
  winCwd: null,
} as const;

it.effect("begins once, truncates summary, and allows a real result to overwrite unknown", () =>
  Effect.gen(function* () {
    const audit = yield* Audit.DesktopChannelAudit;
    const sql = yield* SqlClient.SqlClient;
    yield* audit.begin(entry);
    expect(yield* sql`SELECT * FROM desktop_channel_audit`).toMatchObject([
      {
        request_id: "request",
        host_id: "host",
        server_cwd: "/project",
        outcome: "running",
        summary: "x".repeat(500),
        finished_at: null,
        duration_ms: null,
      },
    ]);
    yield* audit.finish({
      requestId: entry.requestId,
      outcome: "unknown",
      errorCode: "HOST_DISCONNECTED",
      exitCode: null,
      durationMs: null,
      winCwd: null,
    });
    yield* audit.finish({
      requestId: entry.requestId,
      outcome: "exited",
      errorCode: null,
      exitCode: 0,
      durationMs: 42,
      winCwd: "C:\\project",
    });
    expect(yield* sql`SELECT * FROM desktop_channel_audit`).toMatchObject([
      {
        outcome: "exited",
        error_code: null,
        exit_code: 0,
        duration_ms: 42,
        win_cwd: "C:\\project",
        finished_at: expect.any(String),
      },
    ]);
  }).pipe(Effect.provide(Audit.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect("startup sweeps only running rows strictly before process start, once per layer", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const origin = new Date(NodePerfHooks.performance.timeOrigin).toISOString();
    for (const [id, startedAt, outcome] of [
      ["old", "2000-01-01T00:00:00.000Z", "running"],
      ["equal", origin, "running"],
      ["new", "2999-01-01T00:00:00.000Z", "running"],
      ["done", "2000-01-01T00:00:00.000Z", "exited"],
    ]) {
      yield* sql`INSERT INTO desktop_channel_audit (request_id,host_id,host_name,server_cwd,started_at,mode,summary,outcome)
        VALUES (${id},'host','PC','/project',${startedAt},'argv','echo',${outcome})`;
    }
    yield* Effect.gen(function* () {
      const audit = yield* Audit.DesktopChannelAudit;
      const rows = yield* sql`SELECT * FROM desktop_channel_audit ORDER BY request_id`;
      expect(rows).toMatchObject([
        { request_id: "done", outcome: "exited", error_code: null },
        { request_id: "equal", outcome: "running", error_code: null },
        { request_id: "new", outcome: "running", error_code: null },
        {
          request_id: "old",
          outcome: "unknown",
          error_code: "SERVER_RESTARTED",
          finished_at: expect.any(String),
          duration_ms: null,
        },
      ]);
      yield* sql`UPDATE desktop_channel_audit SET outcome='running', error_code=NULL WHERE request_id='old'`;
      yield* audit.begin(entry);
      yield* Audit.DesktopChannelAudit;
      expect(yield* sql`SELECT outcome FROM desktop_channel_audit WHERE request_id='old'`).toEqual([
        { outcome: "running" },
      ]);
    }).pipe(Effect.provide(Audit.layer));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("audit SQL failures warn without failing initialization or calls", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE desktop_channel_audit`;
    const warnings: unknown[] = [];
    yield* Effect.gen(function* () {
      const audit = yield* Audit.DesktopChannelAudit;
      yield* audit.begin(entry);
      yield* audit.finish({
        requestId: entry.requestId,
        outcome: "exited",
        exitCode: null,
        errorCode: null,
        durationMs: 0,
        winCwd: null,
      });
    }).pipe(
      Effect.provide(Audit.layer),
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    expect(warnings).toHaveLength(3);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
