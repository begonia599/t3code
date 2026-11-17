// @effect-diagnostics preferSchemaOverJson:off -- Match the session's layerJson wire encoding exactly.
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as Socket from "effect/unstable/socket/Socket";

export const DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES = 256 * 1024;
export const DESKTOP_CHANNEL_SEND_POLL_MS = 20;

/** Gate only channel traffic; chat, cancellation, and protocol heartbeats bypass the gate. */
export const withDesktopChannelBackpressure = Effect.fnUntraced(function* (
  protocol: RpcClient.Protocol["Service"],
  socket: () => Socket.WebSocketLike | undefined,
) {
  const lock = yield* Semaphore.make(1);
  const encoder = new TextEncoder();
  return {
    ...protocol,
    send: (
      clientId: number,
      request: Parameters<typeof protocol.send>[1],
      transferables?: Parameters<typeof protocol.send>[2],
    ) => {
      if (
        request._tag !== "Request" ||
        (request.tag !== WS_METHODS.desktopChannelEmit &&
          request.tag !== WS_METHODS.desktopChannelRespond)
      ) {
        return protocol.send(clientId, request, transferables);
      }
      return lock.withPermits(1)(
        Effect.gen(function* () {
          // The session uses layerJson, so include JSON escaping and the entire RPC envelope.
          const bytes = encoder.encode(JSON.stringify(request)).byteLength;
          while (true) {
            const ws = socket();
            const buffered =
              ws && "bufferedAmount" in ws && typeof ws.bufferedAmount === "number"
                ? ws.bufferedAmount
                : 0;
            // Large MCP results remain one frame. Drain before admitting one such frame.
            if (
              ws?.readyState !== 1 ||
              buffered + Math.min(bytes, DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES) <=
                DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES
            ) {
              break;
            }
            yield* Effect.sleep(DESKTOP_CHANNEL_SEND_POLL_MS);
          }
          // No asynchronous boundary between the last check and the native socket write.
          return yield* protocol.send(clientId, request, transferables);
        }),
      );
    },
  } satisfies RpcClient.Protocol["Service"];
});
