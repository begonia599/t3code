import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { DESKTOP_SYNC_TUNNEL_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as DesktopSync from "./DesktopSync.ts";

export const routes = Layer.unwrap(
  Effect.gen(function* () {
    const tunnels = yield* DesktopSync.DesktopSync;
    return HttpRouter.add(
      "GET",
      DESKTOP_SYNC_TUNNEL_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const socket = yield* request.upgrade;
        yield* tunnels.connect(
          session.sessionId,
          socket,
          NodeHttpServerRequest.toIncomingMessage(request).socket,
        );
        return HttpServerResponse.empty();
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
).pipe(Layer.provide(DesktopSync.layer));
