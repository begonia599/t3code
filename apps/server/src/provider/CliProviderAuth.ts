import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";
import type { SpawnProviderLogin } from "./ProviderLoginProcess.ts";
import {
  isCliAuthorizationCode,
  readCliLoginInteraction,
  type LoginCli,
} from "./cliProviderAuthSupport.ts";
import { parseGrokModelsCliOutput } from "./Layers/GrokProvider.ts";

const decodeClaudeStatus = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      loggedIn: Schema.Boolean,
      authMethod: Schema.String,
    }),
  ),
);

export const makeCliProviderAuth = Effect.fn("makeCliProviderAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: LoginCli;
  readonly credentialKey: string;
  readonly enabled: boolean;
  readonly spawn: SpawnProviderLogin;
  readonly onChanged: Effect.Effect<void>;
}) {
  const fail = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const run = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* options.spawn(args).pipe(
          Effect.timeout("20 seconds"),
          Effect.mapError(() =>
            fail(
              "start",
              "Could not run the instance's login command. Check its CLI, execution environment, and network.",
            ),
          ),
        );
        let output = "";
        const read = child.output.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if (output.length + chunk.length > 128 * 1024)
                return yield* fail(
                  "output",
                  "The login command returned too much output. Check the CLI version and try again.",
                );
              output += chunk;
            }),
          ),
        );
        const [code] = yield* Effect.all([child.exitCode, read], { concurrency: 2 });
        return { code, output };
      }),
    );
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    timeoutMs: 15 * 60_000,
    methods: Effect.succeed(
      options.enabled
        ? [
            {
              id: options.provider === "claude" ? "claudeai" : "deviceCode",
              name: options.provider === "claude" ? "Sign in with Claude" : "Sign in with Grok",
              description: null,
              type: "agent",
            },
          ]
        : [],
    ),
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        // Retain the same native process from URL generation until authorization completes.
        const child = yield* options
          .spawn(
            options.provider === "claude" ? ["auth", "login"] : ["login", "--device-auth"],
            options.provider === "claude",
          )
          .pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError(() =>
              fail(
                "start",
                "Could not run the instance's login command. Check its CLI, execution environment, and network.",
              ),
            ),
          );
        let output = "";
        let displayed = false;
        let submitted = false;
        const receive = (text: string) =>
          Effect.gen(function* () {
            if (displayed) return;
            const interaction = readCliLoginInteraction(options.provider, text);
            if (!interaction) return;
            displayed = true;
            yield* context.setInteraction(
              { ...interaction, id: context.flowId },
              interaction.type === "authorizationCode"
                ? (response) =>
                    Effect.gen(function* () {
                      if (
                        response.type !== "authorizationCode" ||
                        submitted ||
                        !isCliAuthorizationCode(response.code.trim())
                      )
                        return yield* fail(
                          "respond",
                          "Enter the authorization code from the browser as a single line.",
                        );
                      submitted = true;
                      yield* child
                        .write(response.code.trim() + "\r")
                        .pipe(
                          Effect.mapError(() =>
                            fail(
                              "respond",
                              "Could not send the authorization code. Start sign-in again.",
                            ),
                          ),
                        );
                      yield* context.verifying;
                    })
                : undefined,
            );
          });
        const read = child.output.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if (output.length + chunk.length > 128 * 1024)
                return yield* fail(
                  "output",
                  "The login command returned too much output. Check the CLI version and try again.",
                );
              output += chunk;
              yield* receive(output);
            }),
          ),
        );
        const [code] = yield* Effect.all([child.exitCode, read], { concurrency: 2 });
        if (code !== 0)
          return yield* fail(
            "login",
            "Sign-in did not complete. Update the CLI if needed and try again.",
          );
        yield* receive(output + "\n");
        if (!displayed)
          return yield* fail(
            "start",
            "The CLI did not provide a supported sign-in link. Update it and try again.",
          );
        yield* context.verifying;
        const status = yield* run(
          options.provider === "claude" ? ["auth", "status"] : ["models"],
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(() =>
            fail(
              "verify",
              "Could not verify the new account. Refresh provider status before retrying.",
            ),
          ),
        );
        const authenticated =
          options.provider === "claude"
            ? yield* decodeClaudeStatus(status.output).pipe(
                Effect.map((value) => value.loggedIn && value.authMethod === "claude.ai"),
                Effect.orElseSucceed(() => false),
              )
            : parseGrokModelsCliOutput(status.output).authenticated === true;
        if (status.code !== 0 || !authenticated)
          return yield* fail(
            "verify",
            "The CLI did not confirm an account login. Check this instance's authentication settings.",
          );
        yield* options.onChanged;
      }),
    logout: Effect.gen(function* () {
      if (!options.enabled)
        return yield* fail(
          "logout",
          "Browser sign-in is unavailable for this instance's authentication settings.",
        );
      const result = yield* run(
        options.provider === "claude" ? ["auth", "logout"] : ["logout"],
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(() => fail("logout", "Could not sign out. Try again.")),
      );
      if (result.code !== 0) return yield* fail("logout", "Could not sign out. Try again.");
      yield* options.onChanged;
    }).pipe(Effect.interruptible),
  });
});
