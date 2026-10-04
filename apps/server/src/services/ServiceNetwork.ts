import * as NodeChildProcess from "node:child_process";
import {
  type ProviderInstanceId,
  type ServiceNetworkAction,
  ServiceNetworkError,
  ServiceNetworkState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const BrokerFailure = Schema.Struct({ error: Schema.String });
const decodeBrokerFailure = Schema.decodeUnknownOption(Schema.fromJsonString(BrokerFailure));
const decodeBrokerState = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceNetworkState));

export class ServiceNetwork extends Context.Service<
  ServiceNetwork,
  {
    request: (
      instanceId: ProviderInstanceId,
      action: ServiceNetworkAction,
      payload: unknown,
    ) => Effect.Effect<ServiceNetworkState, ServiceNetworkError>;
  }
>()("t3/services/ServiceNetwork") {
  static readonly layer = Layer.succeed(
    ServiceNetwork,
    ServiceNetwork.of({
      request: Effect.fn("ServiceNetwork.request")(function* (instanceId, action, payload) {
        const output = yield* Effect.callback<string, ServiceNetworkError>((resume) => {
          const child = NodeChildProcess.execFile(
            "/usr/bin/sudo",
            [
              "-n",
              "--",
              "/usr/local/libexec/t3code-service-network",
              "request",
              instanceId,
              action,
              JSON.stringify(payload),
            ],
            { timeout: 30_000, maxBuffer: 256 * 1024 },
            (error, stdout, stderr) => {
              if (error) {
                const failure = decodeBrokerFailure(stderr.trim());
                resume(
                  Effect.fail(
                    new ServiceNetworkError({
                      message:
                        failure._tag === "Some"
                          ? failure.value.error
                          : "Private service networking is unavailable. The T3 host administrator must configure the Linux broker.",
                    }),
                  ),
                );
                return;
              }
              resume(Effect.succeed(stdout));
            },
          );
          return Effect.sync(() => {
            if (child.exitCode === null) child.kill();
          });
        });
        return yield* decodeBrokerState(output).pipe(
          Effect.mapError(
            () =>
              new ServiceNetworkError({
                message: "Invalid response from the private service broker.",
              }),
          ),
        );
      }),
    }),
  );
}
