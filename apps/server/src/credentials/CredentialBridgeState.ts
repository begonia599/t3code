import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

/** Internal process transport state; this is never a client or MCP response. */
export interface CredentialBridgeGrant {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly expiresAt: number;
  readonly environment: Readonly<Record<string, string>>;
}
const grantObservers = new Set<(grants: ReadonlyArray<CredentialBridgeGrant>) => Promise<void>>();
const toolObservers = new Set<() => Promise<void>>();
export function observeToolBindings(observer: () => Promise<void>) {
  toolObservers.add(observer);
  return () => toolObservers.delete(observer);
}
export async function publishToolBindings() {
  await Promise.all([...toolObservers].map((observer) => observer()));
}
const sessionObservers = new Set<
  (scope: McpInvocationScope, authorization: string) => Promise<void>
>();
export function observeCredentialGrants(
  observer: (grants: ReadonlyArray<CredentialBridgeGrant>) => Promise<void>,
) {
  grantObservers.add(observer);
  return () => grantObservers.delete(observer);
}
export function observeCredentialSessions(
  observer: (scope: McpInvocationScope, authorization: string) => Promise<void>,
) {
  sessionObservers.add(observer);
  return () => sessionObservers.delete(observer);
}
export async function publishCredentialGrants(grants: ReadonlyArray<CredentialBridgeGrant>) {
  await Promise.all([...grantObservers].map((observer) => observer(grants)));
}
export async function publishCredentialSession(scope: McpInvocationScope, authorization: string) {
  await Promise.all([...sessionObservers].map((observer) => observer(scope, authorization)));
}
