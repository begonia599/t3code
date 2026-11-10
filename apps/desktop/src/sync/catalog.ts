import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Schema from "effect/Schema";
import { syncHost } from "./protocol.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
/** Resolve afresh for each SSH invocation, so token rotation and removal take effect on reconnect. */
export function resolveCatalogTarget(catalog: string | undefined, host: string) {
  if (!catalog) throw new Error("No direct synchronization environment is configured");
  let document: ReturnType<typeof decode>;
  try {
    document = decode(catalog);
  } catch {
    throw new Error("Invalid synchronization connection catalog");
  }
  const target = document.targets.find((entry) => syncHost(entry.environmentId) === host);
  if (!target) throw new Error("Unknown synchronization host alias");
  if (target._tag !== "BearerConnectionTarget")
    throw new Error(
      "Synchronization v1 supports direct Bearer environments only; relay/DPoP and SSH environments are unsupported",
    );
  if (document.disabledEnvironmentIds.includes(target.environmentId))
    throw new Error("Synchronization environment is disabled");
  const profile = document.profiles.find(
    (entry) =>
      entry.connectionId === target.connectionId && entry.environmentId === target.environmentId,
  );
  const credential = document.credentials.find(
    (entry) => entry.connectionId === target.connectionId,
  )?.credential;
  if (
    profile?._tag !== "BearerConnectionProfile" ||
    credential?._tag !== "BearerConnectionCredential" ||
    !credential.token
  )
    throw new Error(
      "Direct synchronization environment has no Bearer credentials; DPoP is unsupported",
    );
  return { httpBaseUrl: profile.httpBaseUrl, token: credential.token };
}
