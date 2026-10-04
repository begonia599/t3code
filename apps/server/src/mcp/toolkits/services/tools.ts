import {
  ServiceId,
  ServiceNetworkError,
  ServiceNetworkState,
  ServicePublish,
  ServiceShare,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ServiceNetwork } from "../../../services/ServiceNetwork.ts";

const dependencies = [McpInvocationContext, ServiceNetwork];
export const ServicesToolkit = Toolkit.make(
  Tool.make("service_list", {
    description:
      "List this Harness instance's private IP, its public services, temporary service access grants, and available instance IDs. Services run normally in Harness shells. Other Harness instances can connect only after the service owner shares a specific port.",
    parameters: Schema.Record(Schema.String, Schema.Never),
    success: ServiceNetworkState,
    failure: ServiceNetworkError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("service_publish", {
    description:
      "Publish an already-running HTTP service from this Harness through T3's Caddy. The service must listen on the instance's private IP or 0.0.0.0, not only localhost. Specify a dedicated hostname in an allowed domain, with DNS already pointing to this server. T3's hostname and existing host services cannot be used. Publish only when the user requests public access. This does not start, supervise, or extend the lifetime of the process. Other instances' publications cannot be replaced.",
    parameters: ServicePublish,
    success: ServiceNetworkState,
    failure: ServiceNetworkError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("service_unpublish", {
    description:
      "Remove this instance's Caddy publication. The underlying service process keeps running privately.",
    parameters: Schema.Struct({ id: ServiceId }),
    success: ServiceNetworkState,
    failure: ServiceNetworkError,
    dependencies,
  }).annotate(Tool.Readonly, false),
  Tool.make("service_share", {
    description:
      "Temporarily allow one other Harness instance to access a TCP service on this instance's private IP and port. Specify an instance ID from service_list. Access lasts 60 minutes by default, at most 24 hours, and can be revoked. Start the service normally on the private IP or 0.0.0.0 first. No public access or credentials are granted. Use for temporary collaboration requested by the user.",
    parameters: ServiceShare,
    success: ServiceNetworkState,
    failure: ServiceNetworkError,
    dependencies,
  }).annotate(Tool.Readonly, false),
  Tool.make("service_unshare", {
    description:
      "Revoke this instance's temporary TCP service sharing grant, including traffic on existing cross-instance connections.",
    parameters: Schema.Struct({ id: ServiceId }),
    success: ServiceNetworkState,
    failure: ServiceNetworkError,
    dependencies,
  }).annotate(Tool.Readonly, false),
);
