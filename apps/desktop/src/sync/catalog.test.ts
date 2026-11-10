import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { resolveCatalogTarget } from "./catalog.ts";
import { syncHost } from "./protocol.ts";
const decodeCatalog = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const catalog = {
  schemaVersion: 1,
  targets: [
    {
      _tag: "BearerConnectionTarget",
      environmentId: "env:/@ one",
      label: "direct",
      connectionId: "one",
    },
    { _tag: "BearerConnectionTarget", environmentId: "two", label: "other", connectionId: "two" },
    { _tag: "RelayConnectionTarget", environmentId: "relay", label: "relay" },
  ],
  profiles: ["one", "two"].map((id) => ({
    _tag: "BearerConnectionProfile",
    connectionId: id,
    environmentId: id === "one" ? "env:/@ one" : "two",
    label: id,
    httpBaseUrl: `https://${id}.test`,
    wsBaseUrl: `wss://${id}.test`,
  })),
  credentials: ["one", "two"].map((id) => ({
    connectionId: id,
    credential: { _tag: "BearerConnectionCredential", token: id },
  })),
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
};
it("routes each stable DNS alias to its own direct Bearer credentials", () => {
  expect(syncHost("env:/@ one")).toMatch(/^t3-[a-f0-9]{56}$/);
  expect(syncHost("two")).not.toBe(syncHost("env:/@ one"));
  expect(resolveCatalogTarget(encode(catalog), syncHost("env:/@ one"))).toEqual({
    httpBaseUrl: "https://one.test",
    token: "one",
  });
  expect(resolveCatalogTarget(encode(catalog), syncHost("two"))).toEqual({
    httpBaseUrl: "https://two.test",
    token: "two",
  });
  expect(decodeCatalog(catalog)).toBeDefined();
});
it("rejects relay, missing, disabled, unknown and credential-less environments", () => {
  expect(() => resolveCatalogTarget(encode(catalog), syncHost("relay"))).toThrow("relay/DPoP");
  expect(() => resolveCatalogTarget(undefined, syncHost("two"))).toThrow("No direct");
  expect(() => resolveCatalogTarget(encode(catalog), "unknown")).toThrow("Unknown");
  expect(() =>
    resolveCatalogTarget(encode({ ...catalog, disabledEnvironmentIds: ["two"] }), syncHost("two")),
  ).toThrow("disabled");
  expect(() =>
    resolveCatalogTarget(encode({ ...catalog, credentials: [] }), syncHost("two")),
  ).toThrow("DPoP");
});
