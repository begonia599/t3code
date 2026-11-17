import * as NodePerfHooks from "node:perf_hooks";
import {
  DESKTOP_AUDIT_SERVER_RESTARTED,
  DESKTOP_EXEC_SUMMARY_MAX_CHARS,
  type DesktopExecLogEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type Begin = Pick<
  DesktopExecLogEntry,
  "requestId" | "threadId" | "provider" | "label" | "mode" | "summary" | "winCwd"
> & { hostId: string; hostName: string; serverCwd: string };
type Finish = Pick<
  DesktopExecLogEntry,
  "requestId" | "outcome" | "exitCode" | "errorCode" | "durationMs" | "winCwd"
>;

export class DesktopChannelAudit extends Context.Service<
  DesktopChannelAudit,
  {
    readonly begin: (entry: Begin) => Effect.Effect<void>;
    readonly finish: (entry: Finish) => Effect.Effect<void>;
  }
>()("t3/desktopChannel/DesktopChannelAudit") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bestEffort = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("Desktop channel audit write failed", { operation, cause }),
      ),
      Effect.uninterruptible,
    );
  // Process origin, rather than layer initialization, excludes calls made by this process
  // even if another consumer initializes its audit layer later.
  const processStartedAt = DateTime.formatIso(
    DateTime.makeUnsafe(NodePerfHooks.performance.timeOrigin),
  );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const finishedAt = yield* now;
  yield* bestEffort(
    "startup",
    sql`UPDATE desktop_channel_audit
    SET outcome='unknown', error_code=${DESKTOP_AUDIT_SERVER_RESTARTED}, finished_at=${finishedAt}, duration_ms=NULL
    WHERE outcome='running' AND started_at < ${processStartedAt}`,
  );

  const begin = Effect.fn("DesktopChannelAudit.begin")(function* (entry: Begin) {
    const startedAt = yield* now;
    yield* bestEffort(
      "begin",
      sql`INSERT INTO desktop_channel_audit
      (request_id, host_id, host_name, server_cwd, started_at, thread_id, provider, label, mode, summary, win_cwd, outcome)
      VALUES (${entry.requestId}, ${entry.hostId}, ${entry.hostName}, ${entry.serverCwd}, ${startedAt},
      ${entry.threadId}, ${entry.provider}, ${entry.label}, ${entry.mode}, ${entry.summary.slice(0, DESKTOP_EXEC_SUMMARY_MAX_CHARS)}, ${entry.winCwd}, 'running')`,
    );
  }, Effect.uninterruptible);
  const finish = Effect.fn("DesktopChannelAudit.finish")(function* (entry: Finish) {
    const finishedAt = yield* now;
    // A definitive late result must be able to replace an unknown outcome.
    yield* bestEffort(
      "finish",
      sql`UPDATE desktop_channel_audit SET finished_at=${finishedAt},
      outcome=${entry.outcome}, exit_code=${entry.exitCode}, error_code=${entry.errorCode},
      duration_ms=${entry.durationMs}, win_cwd=${entry.winCwd} WHERE request_id=${entry.requestId}`,
    );
  }, Effect.uninterruptible);
  return DesktopChannelAudit.of({ begin, finish });
});

export const layer = Layer.effect(DesktopChannelAudit, make);
