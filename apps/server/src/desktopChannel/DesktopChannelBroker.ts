import {
  DesktopChannelError,
  type AuthSessionId,
  type DesktopChannelCapabilities,
  type DesktopChannelEmit,
  type DesktopChannelErrorCode,
  type DesktopChannelHost,
  type DesktopChannelRequestContext,
  type DesktopChannelResponse,
  type DesktopChannelStreamEvent,
  type DesktopChannelUpdateCapabilities,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

interface ConnectionAuth {
  readonly subject: string;
  readonly sessionId: AuthSessionId;
}

interface InvokeInput {
  readonly hostId?: string;
  readonly kind: string;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly context?: DesktopChannelRequestContext;
}

interface RequestHandle {
  readonly hostId: string;
  readonly requestId: string;
  /** A single consumer; ending this stream discards subsequent batches, not the result. */
  readonly events: Stream.Stream<DesktopChannelEmit>;
  readonly result: Effect.Effect<unknown, DesktopChannelError>;
  readonly cancel: Effect.Effect<void>;
}

export class DesktopChannelBrokerOptions extends Context.Reference<{
  readonly maxInFlightPerHost: number;
  readonly eventBufferCapacity: number;
}>("t3/desktopChannel/DesktopChannelBrokerOptions", {
  defaultValue: () => ({ maxInFlightPerHost: 16, eventBufferCapacity: 256 }),
}) {}

export class DesktopChannelBroker extends Context.Service<
  DesktopChannelBroker,
  {
    readonly connect: (
      host: DesktopChannelHost,
      auth: ConnectionAuth,
    ) => Effect.Effect<Stream.Stream<DesktopChannelStreamEvent>>;
    readonly respond: (
      response: DesktopChannelResponse,
    ) => Effect.Effect<void, DesktopChannelError>;
    readonly emit: (batch: DesktopChannelEmit) => Effect.Effect<void, DesktopChannelError>;
    readonly updateCapabilities: (
      input: DesktopChannelUpdateCapabilities,
    ) => Effect.Effect<void, DesktopChannelError>;
    readonly invoke: (
      input: InvokeInput,
    ) => Effect.Effect<RequestHandle, DesktopChannelError, Scope.Scope>;
    readonly ping: (hostId?: string) => Effect.Effect<unknown, DesktopChannelError>;
    readonly listHosts: () => Effect.Effect<
      ReadonlyArray<
        DesktopChannelHost & {
          readonly connectionId: string;
          readonly connectedAt: number;
          readonly auth: ConnectionAuth;
        }
      >
    >;
    readonly getLastCapabilities: (
      hostId: string,
    ) => Effect.Effect<DesktopChannelCapabilities | undefined>;
  }
>()("t3/desktopChannel/DesktopChannelBroker") {}

interface PendingRequest {
  readonly requestId: string;
  readonly result: Deferred.Deferred<unknown, DesktopChannelError>;
  readonly stopEmits: Deferred.Deferred<void>;
  readonly events: Queue.Queue<DesktopChannelEmit, Cause.Done>;
  readonly emitLock: Semaphore.Semaphore;
  nextSeq: number;
  eventsClosed: boolean;
}

interface Connection {
  host: DesktopChannelHost;
  readonly connectionId: string;
  readonly connectedAt: number;
  readonly auth: ConnectionAuth;
  readonly messages: Queue.Queue<DesktopChannelStreamEvent, Cause.Done>;
  readonly pending: Map<string, PendingRequest>;
  requestSequence: number;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const options = yield* DesktopChannelBrokerOptions;
  const connections = new Map<string, Connection>();
  const capabilities = new Map<string, DesktopChannelCapabilities>();

  const error = (
    code: DesktopChannelErrorCode,
    message: string,
    hostId?: string,
    requestId?: string,
  ) =>
    new DesktopChannelError({
      code,
      message,
      ...(hostId === undefined ? {} : { hostId }),
      ...(requestId === undefined ? {} : { requestId }),
    });

  // State transitions and unbounded control-message offers are synchronous, so
  // completion cannot interleave with routing. Only per-request event offers wait.
  const finishUnsafe = (
    connection: Connection,
    entry: PendingRequest,
    result: Effect.Effect<unknown, DesktopChannelError>,
    cancel = false,
  ) => {
    if (!connection.pending.delete(entry.requestId)) return;
    if (cancel)
      Queue.offerUnsafe(connection.messages, { type: "cancel", requestId: entry.requestId });
    Deferred.doneUnsafe(entry.result, result);
    Deferred.doneUnsafe(entry.stopEmits, Effect.void);
    Queue.endUnsafe(entry.events);
  };

  const retireUnsafe = (connection: Connection, code: "HOST_DISCONNECTED" | "HOST_REPLACED") => {
    for (const entry of connection.pending.values()) {
      finishUnsafe(
        connection,
        entry,
        Effect.fail(
          error(
            code,
            code === "HOST_DISCONNECTED"
              ? "Desktop host disconnected; the remote request state is unknown."
              : "Desktop host connection was replaced; the remote request state is unknown.",
            connection.host.hostId,
            entry.requestId,
          ),
        ),
      );
    }
    Queue.endUnsafe(connection.messages);
  };

  const acquire = Effect.fn("DesktopChannelBroker.acquire")(function* (
    host: DesktopChannelHost,
    auth: ConnectionAuth,
  ) {
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const messages = yield* Queue.unbounded<DesktopChannelStreamEvent, Cause.Done>();
    const connectedAt = yield* Clock.currentTimeMillis;
    return yield* Effect.sync(() => {
      const previous = connections.get(host.hostId);
      if (previous) retireUnsafe(previous, "HOST_REPLACED");
      const connection: Connection = {
        host,
        auth: { ...auth },
        connectionId,
        connectedAt,
        messages,
        pending: new Map(),
        requestSequence: 0,
      };
      connections.set(host.hostId, connection);
      capabilities.set(host.hostId, host.capabilities);
      Queue.offerUnsafe(messages, { type: "connected", connectionId });
      return connection;
    });
  });

  const connect: DesktopChannelBroker["Service"]["connect"] = (host, auth) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquire(host, auth), (connection) =>
          Effect.sync(() => {
            if (connections.get(host.hostId) !== connection) return;
            connections.delete(host.hostId);
            retireUnsafe(connection, "HOST_DISCONNECTED");
          }),
        ).pipe(
          Effect.map((connection) =>
            Stream.fromQueue(connection.messages).pipe(
              // Check each delivery after downstream resumes, including messages
              // pulled in the same queue batch before a timeout or replacement.
              Stream.rechunk(1),
              Stream.filter(
                (message) =>
                  connections.get(host.hostId) === connection &&
                  (message.type !== "request" || connection.pending.has(message.requestId)),
              ),
            ),
          ),
        ),
      ),
    );

  const stale = (input: { hostId: string; requestId?: string }) =>
    error(
      "STALE_CONNECTION",
      "Host, connection or request does not match an active registration.",
      input.hostId,
      input.requestId,
    );

  const currentConnection = (input: { hostId: string; connectionId: string }) => {
    const connection = connections.get(input.hostId);
    return connection?.connectionId === input.connectionId ? connection : undefined;
  };

  const respond: DesktopChannelBroker["Service"]["respond"] = Effect.fn(
    "DesktopChannelBroker.respond",
  )((response) =>
    Effect.suspend(() => {
      const connection = currentConnection(response);
      const entry = connection?.pending.get(response.requestId);
      if (!connection || !entry) return Effect.fail(stale(response));
      finishUnsafe(
        connection,
        entry,
        response.ok
          ? Effect.succeed(response.result)
          : Effect.fail(
              new DesktopChannelError({
                code: "HOST_ERROR",
                message: response.error.message,
                remoteCode: response.error.code,
                hostId: response.hostId,
                requestId: response.requestId,
              }),
            ),
      );
      return Effect.void;
    }),
  );

  const emit: DesktopChannelBroker["Service"]["emit"] = Effect.fn("DesktopChannelBroker.emit")(
    (batch) =>
      Effect.suspend(() => {
        const connection = currentConnection(batch);
        if (!connection) return Effect.fail(stale(batch));
        const entry = connection.pending.get(batch.requestId);
        if (!entry) {
          // Connection-scoped sequence IDs recognize late batches without retaining
          // an ever-growing set of completed requests for long-lived desktops.
          const sequence = Number(batch.requestId.slice(connection.connectionId.length + 1));
          const issued =
            Number.isSafeInteger(sequence) &&
            sequence > 0 &&
            sequence <= connection.requestSequence &&
            batch.requestId === `${connection.connectionId}:${sequence}`;
          return issued ? Effect.void : Effect.fail(stale(batch));
        }
        return entry.emitLock.withPermits(1)(
          Effect.suspend(() => {
            if (currentConnection(batch) !== connection) return Effect.fail(stale(batch));
            if (entry.eventsClosed || !connection.pending.has(batch.requestId)) return Effect.void;
            if (batch.seq !== entry.nextSeq)
              return Effect.fail(
                error(
                  "STALE_CONNECTION",
                  `Expected event seq ${entry.nextSeq}, received ${batch.seq}.`,
                  batch.hostId,
                  batch.requestId,
                ),
              );
            return Effect.uninterruptibleMask((restore) =>
              restore(
                Queue.offer(entry.events, batch).pipe(
                  Effect.raceFirst(Deferred.await(entry.stopEmits).pipe(Effect.as(false))),
                ),
              ).pipe(
                Effect.tap((accepted) =>
                  Effect.sync(() => {
                    if (accepted) entry.nextSeq++;
                  }),
                ),
                Effect.asVoid,
              ),
            );
          }),
        );
      }),
  );

  const updateCapabilities: DesktopChannelBroker["Service"]["updateCapabilities"] = (input) =>
    Effect.suspend(() => {
      const connection = currentConnection(input);
      if (!connection) return Effect.fail(stale(input));
      connection.host = { ...connection.host, capabilities: input.capabilities };
      capabilities.set(input.hostId, input.capabilities);
      return Effect.void;
    });

  const invoke: DesktopChannelBroker["Service"]["invoke"] = Effect.fn(
    "DesktopChannelBroker.invoke",
  )(function* (input) {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const result = yield* Deferred.make<unknown, DesktopChannelError>();
    const stopEmits = yield* Deferred.make<void>();
    const events = yield* Queue.bounded<DesktopChannelEmit, Cause.Done>(
      options.eventBufferCapacity,
    );
    const emitLock = yield* Semaphore.make(1);
    const { connection, entry } = yield* Effect.acquireRelease(
      Effect.suspend(() => {
        const enabled = [...connections.values()].filter(
          (value) => value.host.capabilities.enabled,
        );
        const connection = input.hostId === undefined ? enabled[0] : connections.get(input.hostId);
        if (input.hostId === undefined && enabled.length > 1)
          return Effect.fail(
            error("HOST_AMBIGUOUS", "Multiple desktop hosts are available; specify hostId."),
          );
        if (!connection)
          return Effect.fail(error("HOST_OFFLINE", "Desktop host is offline.", input.hostId));
        if (!connection.host.capabilities.enabled)
          return Effect.fail(
            error(
              "HOST_DISABLED",
              "Desktop channel is disabled on this host.",
              connection.host.hostId,
            ),
          );
        if (connection.pending.size >= options.maxInFlightPerHost)
          return Effect.fail(
            error(
              "HOST_BUSY",
              "Desktop host has reached its in-flight request limit.",
              connection.host.hostId,
            ),
          );
        const requestId = `${connection.connectionId}:${++connection.requestSequence}`;
        const entry: PendingRequest = {
          requestId,
          result,
          stopEmits,
          events,
          emitLock,
          nextSeq: 0,
          eventsClosed: false,
        };
        connection.pending.set(requestId, entry);
        Queue.offerUnsafe(connection.messages, {
          type: "request",
          requestId,
          kind: input.kind,
          input: input.input,
          timeoutMs,
          context: input.context ?? {},
        });
        return Effect.succeed({ connection, entry });
      }),
      ({ connection, entry }) =>
        Effect.sync(() => {
          finishUnsafe(
            connection,
            entry,
            Effect.fail(
              error(
                "CANCELLED",
                "Desktop request scope ended.",
                connection.host.hostId,
                entry.requestId,
              ),
            ),
            true,
          );
        }).pipe(Effect.andThen(Queue.shutdown(events))),
    );

    const cancelWith = (code: "CANCELLED" | "TIMEOUT") =>
      Effect.sync(() => {
        finishUnsafe(
          connection,
          entry,
          Effect.fail(
            error(
              code,
              code === "TIMEOUT" ? "Desktop request timed out." : "Desktop request was cancelled.",
              connection.host.hostId,
              entry.requestId,
            ),
          ),
          true,
        );
      });
    yield* Deferred.await(result).pipe(
      Effect.exit,
      Effect.asVoid,
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => cancelWith("TIMEOUT") }),
      Effect.forkScoped,
    );
    return {
      hostId: connection.host.hostId,
      requestId: entry.requestId,
      events: Stream.fromQueue(events).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            entry.eventsClosed = true;
            Deferred.doneUnsafe(stopEmits, Effect.void);
            Queue.endUnsafe(events);
          }).pipe(Effect.andThen(Queue.shutdown(events))),
        ),
      ),
      result: Deferred.await(result),
      cancel: cancelWith("CANCELLED"),
    };
  });

  const ping: DesktopChannelBroker["Service"]["ping"] = (hostId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* invoke({
          ...(hostId === undefined ? {} : { hostId }),
          kind: "ping",
          input: {},
        });
        yield* Stream.runDrain(handle.events).pipe(Effect.forkScoped);
        return yield* handle.result;
      }),
    );

  return DesktopChannelBroker.of({
    connect,
    respond,
    emit,
    updateCapabilities,
    invoke,
    ping,
    listHosts: () =>
      Effect.sync(() =>
        [...connections.values()].map((connection) => ({
          ...connection.host,
          connectionId: connection.connectionId,
          connectedAt: connection.connectedAt,
          auth: { ...connection.auth },
        })),
      ),
    getLastCapabilities: (hostId) => Effect.sync(() => capabilities.get(hostId)),
  });
});

export const layer = Layer.effect(DesktopChannelBroker, make);
