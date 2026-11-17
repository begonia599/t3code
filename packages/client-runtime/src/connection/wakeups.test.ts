import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Wakeups from "./wakeups.ts";

afterEach(() => vi.unstubAllGlobals());

it.effect(
  "passes the desktop preload wake event to the health probe path and removes its listener",
  () =>
    Effect.gen(function* () {
      const listening = yield* Deferred.make<void>();
      const target = new EventTarget();
      const add = vi.spyOn(target, "addEventListener").mockImplementation((...args) => {
        EventTarget.prototype.addEventListener.call(target, ...args);
        Deferred.doneUnsafe(listening, Effect.void);
      });
      const remove = vi.spyOn(target, "removeEventListener");
      vi.stubGlobal("window", target);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const wakeups = yield* Wakeups.ConnectionWakeups;
          return yield* Stream.runHead(wakeups.changes);
        }),
      ).pipe(Effect.provide(Wakeups.layer({ changes: Stream.never })), Effect.forkChild);
      yield* Deferred.await(listening);
      target.dispatchEvent(new Event("t3:connection-wakeup"));
      expect(Option.getOrThrow(yield* Fiber.join(result))).toBe("application-active-probe");
      expect(remove).toHaveBeenCalledWith("t3:connection-wakeup", add.mock.calls[0]![1]);
    }),
);

it.effect.each([undefined, {}])("preserves platform wakeups without a DOM bridge (%j)", (window) =>
  Effect.gen(function* () {
    vi.stubGlobal("window", window);
    const events = yield* Effect.scoped(
      Effect.gen(function* () {
        const wakeups = yield* Wakeups.ConnectionWakeups;
        return yield* Stream.runCollect(wakeups.changes);
      }),
    ).pipe(Effect.provide(Wakeups.layer({ changes: Stream.succeed("application-active") })));
    expect(events).toEqual(["application-active"]);
  }),
);
