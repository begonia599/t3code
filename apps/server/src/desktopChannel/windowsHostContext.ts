import type { DesktopChannelHost, DesktopChannelRequestContext } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as DesktopLinkService from "../desktopLink/DesktopLinkService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

/** Resolve project routing from server-owned records, never tool arguments. */
export const resolveWindowsContext = Effect.fn("resolveWindowsContext")(function* (
  scope: McpInvocationScope,
  label?: string,
) {
  const query = yield* ProjectionSnapshotQuery;
  const links = yield* DesktopLinkService.DesktopLinkService;
  const context: DesktopChannelRequestContext = {
    threadId: scope.threadId,
    provider: scope.providerInstanceId,
    ...(label === undefined ? {} : { label }),
  };
  const thread = yield* query.getThreadShellById(scope.threadId);
  if (Option.isNone(thread)) return { context, link: undefined };
  const project = yield* query.getProjectShellById(thread.value.projectId);
  if (Option.isNone(project)) return { context, link: undefined };
  const link = Option.getOrUndefined(yield* links.getLinkForProject(project.value.id));
  return {
    context: {
      ...context,
      projectId: project.value.id,
      workspaceRoot: project.value.workspaceRoot,
      ...(link ? { linkedHostId: link.hostId } : {}),
    },
    link,
  };
});

/** Explicit selectors and project links never fall back to another computer. */
export function windowsHostCandidates(
  hosts: readonly DesktopChannelHost[],
  name: string | undefined,
  linkedHostId: string | undefined,
  eligible: (host: DesktopChannelHost) => boolean,
): readonly DesktopChannelHost[] {
  if (name) {
    const exact = hosts.find((host) => host.hostId === name);
    return exact
      ? [exact]
      : hosts.filter((host) => host.hostName.toLowerCase() === name.toLowerCase());
  }
  if (linkedHostId) return hosts.filter((host) => host.hostId === linkedHostId);
  return hosts.filter(eligible);
}
