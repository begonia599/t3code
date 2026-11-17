// @effect-diagnostics preferSchemaOverJson:off -- Model the actual layerJson bytes enqueued by the socket.
import { WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import {
  DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES,
  DESKTOP_CHANNEL_SEND_POLL_MS,
  withDesktopChannelBackpressure,
} from "./desktopChannelBackpressure.ts";

type Request = Parameters<RpcClient.Protocol["Service"]["send"]>[1];
const request = (id: string, tag: string = WS_METHODS.desktopChannelEmit, data = "x") =>
  ({
    _tag: "Request",
    id,
    tag,
    payload: { events: [{ kind: "stdout", data }] },
    headers: [],
  }) satisfies Request;

function setup() {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    send: () => {},
  };
  const sent: Request[] = [];
  let peak = 0;
  const protocol = RpcClient.Protocol.of({
    send: (_id, value) =>
      Effect.sync(() => {
        sent.push(value);
        socket.bufferedAmount += new TextEncoder().encode(JSON.stringify(value)).byteLength;
        peak = Math.max(peak, socket.bufferedAmount);
      }),
    run: () => Effect.never,
    supportsAck: true,
    supportsTransferables: false,
    codecFor: RpcSerialization.json.codecFor,
  });
  return { socket, sent, protocol, peak: () => peak };
}

it.effect(
  "bounds aggregate wire bytes from concurrent output streams and preserves every event",
  () =>
    Effect.gen(function* () {
      const test = setup();
      const gated = yield* withDesktopChannelBackpressure(test.protocol, () => test.socket);
      const values = Array.from({ length: 8 }, (_, producer) =>
        Array.from({ length: 40 }, (_, index) =>
          request(
            `${producer}-${index}`,
            WS_METHODS.desktopChannelEmit,
            `${producer}-${index}:` + '\u0000汉😀"\\\n'.repeat(2048),
          ),
        ),
      );
      const writers = yield* Effect.forEach(values, (stream) =>
        Effect.forkChild(Effect.forEach(stream, (value) => gated.send(0, value))),
      );
      for (let tick = 0; tick < 320 && test.sent.length < 320; tick++) {
        test.socket.bufferedAmount = 0;
        yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
        expect(test.socket.bufferedAmount).toBeLessThanOrEqual(
          DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES,
        );
      }
      yield* Effect.forEach(writers, Fiber.join);
      expect(test.peak()).toBeLessThanOrEqual(DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES);
      expect(test.sent).toHaveLength(320);
      for (const [producer, stream] of values.entries()) {
        expect(
          test.sent.filter(
            (value) => value._tag === "Request" && value.id.toString().startsWith(`${producer}-`),
          ),
        ).toEqual(stream);
      }
    }),
);

it.effect(
  "lets chat and interrupts pass blocked output, and stops waiting on a closed socket",
  () =>
    Effect.gen(function* () {
      const test = setup();
      test.socket.bufferedAmount = DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES;
      const gated = yield* withDesktopChannelBackpressure(test.protocol, () => test.socket);
      const output = yield* Effect.forkChild(gated.send(0, request("output")));
      yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
      expect(test.sent).toEqual([]);
      const chat = { ...request("chat"), tag: "chat.send" };
      const cancel: Request = { _tag: "Interrupt", requestId: "output" };
      yield* gated.send(0, chat);
      yield* gated.send(0, cancel);
      expect(test.sent).toEqual([chat, cancel]);
      test.socket.readyState = 3;
      yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
      yield* Fiber.join(output);
      expect(test.sent.at(-1)).toEqual(request("output"));
    }),
);

it.effect("drains before an indivisible MCP result and gates subsequent output behind it", () =>
  Effect.gen(function* () {
    const test = setup();
    test.socket.bufferedAmount = 1;
    const gated = yield* withDesktopChannelBackpressure(test.protocol, () => test.socket);
    const result = request("result", WS_METHODS.desktopChannelRespond, "x".repeat(1024 * 1024));
    const writer = yield* Effect.forkChild(gated.send(0, result));
    yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
    expect(test.sent).toEqual([]);
    test.socket.bufferedAmount = 0;
    yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
    yield* Fiber.join(writer);
    const output = yield* Effect.forkChild(gated.send(0, request("output")));
    yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
    expect(test.sent).toEqual([result]);
    test.socket.bufferedAmount = 0;
    yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
    yield* Fiber.join(output);
    expect(test.sent).toEqual([result, request("output")]);
  }),
);

it.effect("interrupts a blocked sender without sending or retaining the connection lock", () =>
  Effect.gen(function* () {
    const test = setup();
    test.socket.bufferedAmount = DESKTOP_CHANNEL_SEND_HIGH_WATER_BYTES;
    const gated = yield* withDesktopChannelBackpressure(test.protocol, () => test.socket);
    const writer = yield* Effect.forkChild(gated.send(0, request("cancelled")));
    yield* TestClock.adjust(DESKTOP_CHANNEL_SEND_POLL_MS);
    yield* Fiber.interrupt(writer);
    test.socket.bufferedAmount = 0;
    yield* gated.send(0, request("next"));
    expect(test.sent).toEqual([request("next")]);
  }),
);
