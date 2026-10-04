// @effect-diagnostics nodeBuiltinImport:off - The narrow installed broker receives secret bindings through stdin, never argv.
import * as NodeChildProcess from "node:child_process";
import {
  ApplicationError,
  ApplicationErrorCode,
  ApplicationResponse,
  HarnessEnvironmentInfo,
  type ApplicationRequest,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CredentialVault } from "../credentials/CredentialVault.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

const Failure = Schema.Struct({ code: ApplicationErrorCode, message: Schema.String });
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(Failure));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEnvironment = Schema.decodeUnknownEffect(
  Schema.Struct({ environment: HarnessEnvironmentInfo }),
);
export interface ApplicationScope {
  readonly providerInstanceId: ProviderInstanceId;
  readonly allowedFileRoots?: ReadonlyArray<string> | undefined;
}
export class ApplicationBroker extends Context.Service<
  ApplicationBroker,
  {
    readonly request: (
      scope: ApplicationScope,
      action: string,
      input: unknown,
      credentials?: {
        values: Readonly<Record<string, string>>;
        versions: Readonly<Record<string, number>>;
      },
    ) => Effect.Effect<unknown, ApplicationError>;
  }
>()("t3/services/ApplicationBroker") {
  static readonly layer = Layer.succeed(ApplicationBroker, {
    request: (scope, action, input, credentials) =>
      Effect.callback((resume) => {
        const child = NodeChildProcess.execFile(
          "/usr/bin/sudo",
          [
            "-n",
            "--",
            "/usr/local/libexec/t3code-applications",
            "request",
            scope.providerInstanceId,
            action,
          ],
          { timeout: action === "exec" ? 135_000 : 35_000, maxBuffer: 2 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              const failure = decodeFailure(stderr.trim());
              resume(
                Effect.fail(
                  new ApplicationError(
                    failure._tag === "Some"
                      ? failure.value
                      : {
                          code: "not_configured",
                          message:
                            "Application hosting is unavailable. The T3 host administrator must configure the Linux Docker broker.",
                        },
                  ),
                ),
              );
            } else
              resume(
                decodeUnknownJson(stdout).pipe(
                  Effect.mapError(
                    () =>
                      new ApplicationError({
                        code: "internal_error",
                        message: "The application broker returned an invalid response.",
                      }),
                  ),
                ),
              );
          },
        );
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(
          JSON.stringify({ roots: scope.allowedFileRoots ?? [], input, ...credentials }),
        );
        return Effect.sync(() => {
          if (child.exitCode === null) child.kill();
        });
      }),
  });
}
export class Applications extends Context.Service<
  Applications,
  {
    readonly request: (
      scope: ApplicationScope,
      request: ApplicationRequest,
    ) => Effect.Effect<ApplicationResponse, ApplicationError>;
    readonly environment: (
      scope: McpInvocationScope,
    ) => Effect.Effect<typeof HarnessEnvironmentInfo.Type, ApplicationError>;
  }
>()("t3/services/Applications") {}
export const make = Effect.gen(function* () {
  const broker = yield* ApplicationBroker;
  const vault = yield* CredentialVault;
  const parse = Schema.decodeUnknownEffect(ApplicationResponse);
  return Applications.of({
    request: Effect.fn("Applications.request")(function* (scope, request) {
      if (!scope.allowedFileRoots?.length)
        return yield* new ApplicationError({
          code: "not_allowed",
          message: "Application management requires a configured Linux workspace scope.",
        });
      if (request.action !== "publish") {
        let credentials:
          | { values: Readonly<Record<string, string>>; versions: Readonly<Record<string, number>> }
          | undefined;
        if (
          request.action === "rollback" ||
          (request.action === "control" && request.input.action !== "stop")
        ) {
          const inspected = yield* broker
            .request(scope, "inspect", {
              applicationId: request.input.applicationId,
              ...(request.action === "rollback" ? { releaseId: request.input.releaseId } : {}),
            })
            .pipe(
              Effect.flatMap(parse),
              Effect.mapError(
                () =>
                  new ApplicationError({
                    code: "not_found",
                    message: "Cannot inspect this application's selected release.",
                  }),
              ),
            );
          if (!inspected.release)
            return yield* new ApplicationError({
              code: "not_found",
              message: "The selected application release is unavailable.",
            });
          const metadata = inspected.release;
          const resolved = yield* vault
            .resolveBinding(scope.providerInstanceId, metadata.credentialNames)
            .pipe(
              Effect.mapError(
                () =>
                  new ApplicationError({
                    code: "credential_expired",
                    message:
                      "A release credential was removed or is no longer allowed for this instance. Configure the binding and publish a new release.",
                  }),
              ),
            );
          if (
            metadata.credentialNames.some(
              (name) => resolved.versions[name] !== metadata.credentialVersions[name],
            )
          )
            return yield* new ApplicationError({
              code: "credential_expired",
              message:
                "A release credential has changed. Publish a new release to use the current binding; historical values are not revived.",
            });
          credentials = resolved;
        }
        return yield* broker.request(scope, request.action, request.input, credentials).pipe(
          Effect.flatMap(parse),
          Effect.mapError((error) =>
            error instanceof ApplicationError
              ? error
              : new ApplicationError({
                  code: "internal_error",
                  message: "Invalid application response.",
                }),
          ),
        );
      }
      const prepared = yield* broker.request(scope, "prepare", request.input).pipe(
        Effect.flatMap(parse),
        Effect.mapError((error) =>
          error instanceof ApplicationError
            ? error
            : new ApplicationError({
                code: "internal_error",
                message: "Invalid application preparation result.",
              }),
        ),
      );
      if (!prepared.application || !prepared.release || !prepared.operation)
        return yield* new ApplicationError({
          code: "internal_error",
          message: "Incomplete application preparation result.",
        });
      const input = { applicationId: prepared.application.id, operationId: prepared.operation.id };
      const credentials = yield* vault
        .resolveBinding(scope.providerInstanceId, prepared.release.credentialNames)
        .pipe(
          Effect.mapError(
            () =>
              new ApplicationError({
                code: "credential_expired",
                message:
                  "An application vault binding is missing or not allowed for this instance. Configure it in Resources settings.",
              }),
          ),
          Effect.onError(() => broker.request(scope, "abandon", input).pipe(Effect.ignore)),
        );
      return yield* broker.request(scope, "commit", input, credentials).pipe(
        Effect.onError(() => broker.request(scope, "abandon", input).pipe(Effect.ignore)),
        Effect.flatMap(parse),
        Effect.mapError((error) =>
          error instanceof ApplicationError
            ? error
            : new ApplicationError({
                code: "internal_error",
                message: "Invalid application job receipt.",
              }),
        ),
      );
    }),
    environment: (scope) =>
      broker.request(scope, "info", {}).pipe(
        Effect.flatMap(decodeEnvironment),
        Effect.map((result) => result.environment),
        Effect.mapError((error) =>
          error instanceof ApplicationError
            ? error
            : new ApplicationError({
                code: "internal_error",
                message: "Invalid environment capability response.",
              }),
        ),
      ),
  });
});
export const layer = Layer.effect(Applications, make).pipe(Layer.provide(ApplicationBroker.layer));
