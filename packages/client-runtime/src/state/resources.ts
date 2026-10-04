import {
  WS_METHODS,
  type CredentialWriteInput,
  type CredentialVaultAction,
  type HostedMcpConfig,
  type HostedMcpAction,
  type GitHubToolBinding,
  type ToolBindingAction,
  type ApplicationHttpRequest,
  type ApplicationResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import {
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export type ResourceMutation =
  | { readonly type: "write"; readonly payload: CredentialWriteInput }
  | { readonly type: "action"; readonly payload: CredentialVaultAction }
  | { readonly type: "writeMcp"; readonly payload: HostedMcpConfig }
  | { readonly type: "actionMcp"; readonly payload: HostedMcpAction }
  | { readonly type: "writeTool"; readonly payload: GitHubToolBinding }
  | { readonly type: "actionTool"; readonly payload: ToolBindingAction };
export class ResourceClient extends Context.Service<
  ResourceClient,
  {
    readonly mutate: (
      prepared: PreparedConnection,
      input: ResourceMutation,
    ) => Effect.Effect<void, RemoteEnvironmentRequestError>;
    readonly application: (
      prepared: PreparedConnection,
      input: ApplicationHttpRequest,
    ) => Effect.Effect<ApplicationResponse, RemoteEnvironmentRequestError>;
  }
>()("t3/client-runtime/ResourceClient") {}
export const resourceClientLayer = Layer.effect(
  ResourceClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ResourceClient.of({
      application: (prepared, input) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          group: "applications",
          method: "POST",
          timeoutMs: 150_000,
          url: (base) => makeEnvironmentHttpApiUrlBuilder(base).applications.request(),
          request: ({ client, headers }) => client.request({ headers, payload: input }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      mutate: (prepared, input) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          group: "credentialVault",
          method: "POST",
          timeoutMs: 30_000,
          url: (base) => makeEnvironmentHttpApiUrlBuilder(base).credentialVault[input.type](),
          request: ({ client, headers }) => {
            switch (input.type) {
              case "write":
                return client.write({ headers, payload: input.payload }).pipe(Effect.asVoid);
              case "action": {
                const payload = input.payload;
                switch (payload.action) {
                  case "delete":
                    return client.action({ headers, payload }).pipe(Effect.asVoid);
                  case "revoke":
                    return client.action({ headers, payload }).pipe(Effect.asVoid);
                  case "dismiss":
                    return client.action({ headers, payload }).pipe(Effect.asVoid);
                }
              }
              case "writeMcp":
                return client.writeMcp({ headers, payload: input.payload });
              case "actionMcp":
                return client.actionMcp({ headers, payload: input.payload });
              case "writeTool":
                return client.writeTool({ headers, payload: input.payload });
              case "actionTool":
                return client.actionTool({ headers, payload: input.payload });
            }
          },
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    });
  }),
);
export function createResourceAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ResourceClient | R, ER>,
) {
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-resources",
    tag: WS_METHODS.resourcesSubscribe,
    idleTtlMs: 0,
  });
  const mutate = createEnvironmentCommand(runtime, {
    label: "environment-resources:mutate",
    execute: (input: ResourceMutation) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* Effect.fail(new Error("The environment is not connected."));
        return yield* (yield* ResourceClient).mutate(prepared.value, input);
      }),
  });
  const applications = createEnvironmentCommand(runtime, {
    label: "environment-applications:request",
    execute: (input: ApplicationHttpRequest) =>
      Effect.gen(function* () {
        const prepared = yield* SubscriptionRef.get((yield* EnvironmentSupervisor).prepared);
        if (Option.isNone(prepared))
          return yield* Effect.fail(new Error("The environment is not connected."));
        return yield* (yield* ResourceClient).application(prepared.value, input);
      }),
  });
  return { snapshot, mutate, applications };
}
