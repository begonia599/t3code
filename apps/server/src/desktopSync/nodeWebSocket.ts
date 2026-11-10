import { NodeWS } from "@effect/platform-node/NodeSocket";
import type * as NodeNet from "node:net";

/**
 * Effect's Node upgrade preserves the HTTP upgrade head, but its Socket facade exposes neither
 * ping nor send completion. ws attaches its owner to the TCP socket using Symbol(websocket).
 * Keep this compatibility bridge in one place, validate the instance, and fail closed if a
 * platform upgrade changes it. Never install a second upgrade handler (that would lose head).
 */
export function nodeWebSocket(transport: NodeNet.Socket): NodeWS.WebSocket {
  for (const key of Object.getOwnPropertySymbols(transport)) {
    const value: unknown = Reflect.get(transport, key);
    if (key.description === "websocket" && value instanceof NodeWS.WebSocket) return value;
  }
  throw new Error("The Node WebSocket upgrade did not expose its transport owner.");
}
