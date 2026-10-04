import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";
import type { withCodexAppServerClient } from "./Layers/CodexProvider.ts";

const DeviceCode = Schema.Struct({
  loginId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  userCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  verificationUrl: Schema.String.check(
    Schema.isMaxLength(16_384),
    Schema.isPattern(/^https:\/\/auth\.openai\.com\/codex\/device\/?$/),
  ),
});
const decodeDeviceCode = Schema.decodeEffect(DeviceCode);

/** Codex owns token exchange, storage and refresh; T3 only transports the login interaction. */
export const makeCodexAuth = Effect.fn("makeCodexAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialKey: string;
  readonly enabled: boolean;
  readonly connect: Effect.Effect<
    Effect.Success<ReturnType<typeof withCodexAppServerClient>>,
    Effect.Error<ReturnType<typeof withCodexAppServerClient>>,
    Scope.Scope
  >;
  readonly onChanged: Effect.Effect<void>;
}) {
  const fail = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const connect = options.connect.pipe(
    Effect.timeout("20 seconds"),
    Effect.mapError(() =>
      fail("connect", "Could not start Codex sign-in. Check the instance's CLI and network."),
    ),
  );

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    timeoutMs: 15 * 60_000,
    methods: Effect.succeed(
      options.enabled
        ? [
            {
              id: "chatgptDeviceCode",
              name: "Sign in with ChatGPT",
              description: null,
              type: "agent",
            },
          ]
        : [],
    ),
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        const { client, exitCode } = yield* connect;
        const completions = yield* Queue.unbounded<{ loginId: string | null; success: boolean }>();
        yield* client.handleServerNotification("account/login/completed", (result) =>
          Queue.offer(completions, {
            loginId: result.loginId ?? null,
            success: result.success,
          }).pipe(Effect.asVoid),
        );
        const response = yield* client
          .request("account/login/start", { type: "chatgptDeviceCode" })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(() =>
              fail(
                "start",
                "Could not start device-code login. Update Codex, enable device-code login in ChatGPT, and check the instance's network.",
              ),
            ),
          );
        if (response.type !== "chatgptDeviceCode") {
          return yield* fail(
            "start",
            "This Codex version did not return a device-code login. Update Codex and try again.",
          );
        }
        let completed = false;
        yield* Effect.addFinalizer(() =>
          completed
            ? Effect.void
            : client
                .request("account/login/cancel", { loginId: response.loginId })
                .pipe(Effect.interruptible, Effect.timeout("3 seconds"), Effect.ignore),
        );
        const device = yield* decodeDeviceCode(response).pipe(
          Effect.mapError(() => fail("start", "Codex returned an invalid device-code login.")),
        );
        yield* context.setInteraction({
          type: "deviceCode",
          id: context.flowId,
          url: device.verificationUrl,
          userCode: device.userCode,
        });
        yield* Effect.gen(function* () {
          const result = yield* Stream.fromQueue(completions).pipe(
            Stream.filter((result) => result.loginId === device.loginId),
            Stream.take(1),
            Stream.runHead,
          );
          if (result._tag === "None")
            return yield* fail("login", "Codex sign-in ended before authorization completed.");
          completed = true;
          if (!result.value.success)
            return yield* fail("login", "Codex sign-in failed or expired. Start again.");
          yield* context.verifying;
          const account = yield* client.request("account/read", { refreshToken: false }).pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError(() =>
              fail(
                "verify",
                "Could not verify the Codex account. Refresh provider status before retrying.",
              ),
            ),
          );
          if (account.account?.type !== "chatgpt") {
            return yield* fail(
              "verify",
              "Codex did not report a ChatGPT account. Check the instance's authentication settings.",
            );
          }
          yield* options.onChanged;
        }).pipe(
          Effect.raceFirst(
            exitCode.pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  Effect.fail(
                    fail("login", "Codex exited before sign-in could be verified. Start again."),
                  ),
                onFailure: () =>
                  Effect.fail(
                    fail("login", "The Codex login process could not be monitored. Start again."),
                  ),
              }),
            ),
          ),
        );
      }),
    logout: Effect.gen(function* () {
      const { client } = yield* connect;
      yield* client.request("account/logout", undefined).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("logout", "Could not sign out of Codex. Try again.")),
      );
      yield* options.onChanged;
    }).pipe(Effect.interruptible, Effect.scoped),
  });
});
