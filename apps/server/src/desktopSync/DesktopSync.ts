import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopSyncClientMessage,
  DesktopSyncServerMessage,
  DESKTOP_SYNC_MAX_FRAME_BYTES,
  DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS,
  DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS,
  DESKTOP_SYNC_MAX_CONCURRENT_PER_ENVIRONMENT,
  DESKTOP_SYNC_STDERR_LIMIT_BYTES,
  DESKTOP_SYNC_OPEN_TIMEOUT_MS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import type * as NodeNet from "node:net";
import { startAgent, TunnelError } from "./agent.ts";
import { parseCommand } from "./command.ts";
import { nodeWebSocket } from "./nodeWebSocket.ts";

export class DesktopSync extends Context.Service<
  DesktopSync,
  {
    readonly connect: (
      session: string,
      socket: Socket.Socket,
      transport: NodeNet.Socket,
    ) => Effect.Effect<void>;
  }
>()("t3/desktopSync/DesktopSync") {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopSyncClientMessage), {
  onExcessProperty: "error",
});
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopSyncServerMessage));
const protocolError = () =>
  new TunnelError({ code: "PROTOCOL_ERROR", message: "Invalid synchronization tunnel message." });

const make = Effect.gen(function* () {
  const active = new Set<{ stop: Deferred.Deferred<void>; done: Deferred.Deferred<void> }>();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const entry of active) yield* Deferred.succeed(entry.stop, undefined);
      for (const entry of active) yield* Deferred.await(entry.done);
    }),
  );

  const connect = Effect.fn("DesktopSync.connect")(function* (
    session: string,
    socket: Socket.Socket,
    transport: NodeNet.Socket,
  ) {
    const started = Date.now();
    let upstreamBytes = 0;
    let downstreamBytes = 0;
    let exitCode: number | null = null;
    let reason = "disconnected";
    const fields = () => ({
      session,
      durationMs: Date.now() - started,
      upstreamBytes,
      downstreamBytes,
      exitCode,
      reason,
    });
    const stop = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const entry = { stop, done };
    const admitted = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        // Reserve atomically with cleanup registration; sessions share the environment budget.
        const admitted = active.size < DESKTOP_SYNC_MAX_CONCURRENT_PER_ENVIRONMENT;
        if (admitted) active.add(entry);
        yield* Effect.logInfo("desktop sync tunnel opened", fields());
        return admitted;
      }),
      () =>
        Effect.gen(function* () {
          active.delete(entry);
          yield* Effect.logInfo("desktop sync tunnel closed", fields());
          yield* Deferred.succeed(done, undefined);
        }),
    );

    const run = Effect.gen(function* () {
      const reader = yield* socket.reader;
      const ws = yield* Effect.try({
        try: () => nodeWebSocket(transport),
        catch: () => protocolError(),
      });
      // Hard terminate on cancellation/errors as close handshakes can otherwise linger for 30s.
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.terminate()));
      const send = (data: string | Uint8Array) =>
        Effect.callback<void, TunnelError>((resume) => {
          if (ws.readyState !== NodeWS.WebSocket.OPEN) return resume(Effect.fail(protocolError()));
          ws.send(data, { binary: typeof data !== "string", compress: false }, (error) => {
            resume(error ? Effect.fail(protocolError()) : Effect.void);
          });
        });
      const control = (message: DesktopSyncServerMessage) => send(encode(message));
      const close = (code: number) =>
        Effect.callback<void>((resume) => {
          if (ws.readyState === NodeWS.WebSocket.CLOSED) return resume(Effect.void);
          const onClose = () => resume(Effect.void);
          ws.once("close", onClose);
          ws.close(code);
          // Bound the closing handshake too, including peers that stopped reading.
          const timer = setTimeout(() => ws.terminate(), DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS);
          return Effect.sync(() => {
            clearTimeout(timer);
            ws.off("close", onClose);
          });
        });
      const exchange = Effect.gen(function* () {
        if (!admitted)
          return yield* new TunnelError({
            code: "TOO_MANY_TUNNELS",
            message: "This environment already has eight synchronization tunnels.",
          });
        const heartbeat = Effect.callback<void>((resume) => {
          // A separate refreshed deadline expires 30s after activity, not at the next 15s tick.
          const deadline = setTimeout(() => {
            reason = "heartbeat-timeout";
            clearInterval(ping);
            ws.terminate();
            resume(Effect.void);
          }, DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS);
          const touch = () => {
            deadline.refresh();
          };
          const ping = setInterval(() => {
            ws.ping(undefined, undefined, (error) => {
              if (error) {
                if (reason === "disconnected") reason = "websocket-error";
                ws.terminate();
                resume(Effect.void);
              }
            });
          }, DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS);
          ws.on("pong", touch);
          ws.on("ping", touch);
          ws.on("message", touch);
          return Effect.sync(() => {
            clearInterval(ping);
            clearTimeout(deadline);
            ws.off("pong", touch);
            ws.off("ping", touch);
            ws.off("message", touch);
          });
        });
        const transfer = Effect.gen(function* () {
          const firstBatch = yield* reader.pull.pipe(
            Effect.timeoutOrElse({
              duration: DESKTOP_SYNC_OPEN_TIMEOUT_MS,
              orElse: () =>
                Effect.fail(
                  new TunnelError({
                    code: "OPEN_TIMEOUT",
                    message: "No open message received within ten seconds.",
                  }),
                ),
            }),
          );
          const first = firstBatch[0];
          if (typeof first !== "string" || Buffer.byteLength(first) > DESKTOP_SYNC_MAX_FRAME_BYTES)
            return yield* protocolError();
          const open = yield* decode(first).pipe(Effect.mapError(protocolError));
          if (open.type !== "open") return yield* protocolError();
          const command = parseCommand(open.command);
          if (!command.ok)
            return yield* new TunnelError({
              code: command.code,
              message:
                command.code === "VERSION_MISMATCH"
                  ? "Mutagen client and agent versions must match."
                  : "Only the preinstalled Mutagen synchronizer command is allowed.",
            });
          const agent = yield* Effect.acquireRelease(startAgent(command.args), (agent) =>
            Effect.promise(async () => {
              await agent.stop();
              exitCode = (await agent.closed).code;
            }),
          );
          const spawnError = yield* Effect.promise(() => agent.ready);
          if (spawnError)
            return yield* new TunnelError({
              code: "SPAWN_FAILED",
              message: "Could not start the configured Mutagen agent.",
            });
          let eof = false;
          const accept = Effect.fnUntraced(function* (frame: string | Uint8Array) {
            if (
              (typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength) >
              DESKTOP_SYNC_MAX_FRAME_BYTES
            )
              return yield* protocolError();
            if (typeof frame === "string") {
              const message = yield* decode(frame).pipe(Effect.mapError(protocolError));
              if (message.type !== "stdin-eof" || eof) return yield* protocolError();
              eof = true;
              agent.child.stdin.end();
              return;
            }
            if (eof) return yield* protocolError();
            upstreamBytes += frame.byteLength;
            // Stop pulling until the write completes and, on false, until drain. Effect's
            // reader owns ws.pause/resume and prefetches at most its 64 KiB high-water mark.
            // Calling ws.resume here would invalidate that reader's own paused-state tracking.
            yield* Effect.callback<void>((resume) => {
              let written = false;
              let drained = false;
              const complete = () => {
                if (written && drained) resume(Effect.void);
              };
              const onDrain = () => {
                drained = true;
                complete();
              };
              drained = agent.child.stdin.write(frame, (error) => {
                // Closing stdin can precede the agent's final stdout. Keep this pump parked
                // on EPIPE so the output pump can deliver all bytes and the exit receipt.
                if (error) return;
                written = true;
                complete();
              });
              if (!drained) agent.child.stdin.once("drain", onDrain);
              return Effect.sync(() => {
                agent.child.stdin.off("drain", onDrain);
              });
            });
          });
          const input = Effect.gen(function* () {
            for (const frame of firstBatch.slice(1)) yield* accept(frame);
            while (true) for (const frame of yield* reader.pull) yield* accept(frame);
          });
          const stdout = NodeStream.fromReadable({
            evaluate: () => agent.child.stdout,
            onError: protocolError,
          }).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                for (
                  let offset = 0;
                  offset < chunk.byteLength;
                  offset += DESKTOP_SYNC_MAX_FRAME_BYTES
                ) {
                  const part = chunk.subarray(offset, offset + DESKTOP_SYNC_MAX_FRAME_BYTES);
                  // One outstanding send per pump is stricter than the 1 MiB high-water mark;
                  // awaiting its callback stops pulling stdout until the transport accepts it.
                  yield* send(part);
                  downstreamBytes += part.byteLength;
                }
              }),
            ),
          );
          let stderrBytes = 0;
          const decoder = new TextDecoder();
          const stderr = NodeStream.fromReadable({
            evaluate: () => agent.child.stderr,
            onError: protocolError,
          }).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                const bytes = chunk.subarray(
                  0,
                  Math.max(0, DESKTOP_SYNC_STDERR_LIMIT_BYTES - stderrBytes),
                );
                stderrBytes += bytes.byteLength;
                // Small slices also bound JSON escaping overhead within the frame limit.
                for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
                  const data = decoder.decode(bytes.subarray(offset, offset + 4096), {
                    stream: true,
                  });
                  if (data) yield* control({ type: "stderr", data });
                }
              }),
            ),
            Effect.andThen(
              Effect.suspend(() => {
                const data = decoder.decode();
                return data ? control({ type: "stderr", data }) : Effect.void;
              }),
            ),
          );
          const output = Effect.gen(function* () {
            yield* Effect.all([stdout, stderr], { concurrency: "unbounded" });
            const status = yield* Effect.promise(() => agent.closed);
            exitCode = status.code;
            reason = "agent-exit";
            yield* control({ type: "exit", ...status });
            yield* close(1000);
          });
          yield* Effect.raceFirst(input, output);
        });
        yield* Effect.raceFirst(transfer, heartbeat);
      });
      const disconnected = Effect.callback<void>((resume) => {
        const onClose = () => resume(Effect.void);
        const onError = () => {
          if (reason === "disconnected") reason = "websocket-error";
          resume(Effect.void);
        };
        ws.once("close", onClose);
        ws.once("error", onError);
        if (ws.readyState === NodeWS.WebSocket.CLOSED) resume(Effect.void);
        return Effect.sync(() => {
          ws.off("close", onClose);
          ws.off("error", onError);
        });
      });
      yield* Effect.raceFirst(
        exchange.pipe(
          Effect.catchTag("DesktopSyncTunnelError", (error) =>
            Effect.gen(function* () {
              reason = error.code;
              yield* control({ type: "error", code: error.code, message: error.message });
              yield* close(1008);
            }),
          ),
        ),
        disconnected,
      );
    });
    yield* Effect.raceFirst(
      run,
      Deferred.await(stop).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            reason = "server-shutdown";
          }),
        ),
      ),
    ).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.void),
    );
  }, Effect.scoped);
  return DesktopSync.of({ connect });
});

export const layer = Layer.effect(DesktopSync, make);
