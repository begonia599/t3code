import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ServiceNetwork } from "../../../services/ServiceNetwork.ts";
import { ServicesToolkit } from "./tools.ts";

export const make = Effect.gen(function* () {
  const network = yield* ServiceNetwork;
  const request = Effect.fn("ServicesToolkit.request")(function* (
    action: Parameters<typeof network.request>[1],
    payload: unknown,
  ) {
    const scope = yield* McpInvocationContext;
    return yield* network.request(scope.providerInstanceId, action, payload);
  });
  return ServicesToolkit.of({
    service_list: (input) => request("list", input),
    service_publish: (input) => request("publish", input),
    service_unpublish: (input) => request("unpublish", input),
    service_share: (input) => request("share", input),
    service_unshare: (input) => request("unshare", input),
  });
});
export const ServicesToolkitHandlersLive = ServicesToolkit.toLayer(make);
