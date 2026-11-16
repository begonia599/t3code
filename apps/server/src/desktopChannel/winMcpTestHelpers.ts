import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  OrchestrationThreadShell,
  OrchestrationProjectShell,
  type DesktopChannelHost,
  type DesktopChannelStreamEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Broker from "./DesktopChannelBroker.ts";
import * as Relay from "./WinMcpRelay.ts";
import * as DesktopLinkService from "../desktopLink/DesktopLinkService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("e"),
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
  capabilities: new Set(["win"]),
  issuedAt: 0,
};
export const host: DesktopChannelHost = {
  hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
  hostName: "Work PC",
  platform: "win32",
  appVersion: "1",
  environmentId: scope.environmentId,
  capabilities: {
    enabled: true,
    mcp: {
      version: "1",
      servers: [
        {
          id: "unity",
          name: "Unity",
          status: "running",
          tools: [
            {
              name: "inspect",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              annotations: { readOnlyHint: true, localExtension: { version: 1 } },
              title: "Inspect",
              description: "Read scene",
            },
          ],
        },
      ],
    },
  },
};
const projectId = ProjectId.make("project");
const thread = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: scope.threadId,
  projectId,
  title: "T",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "now",
  updatedAt: "now",
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: projectId,
  title: "T",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "now",
  updatedAt: "now",
});
export const testLayer = (linked = false) =>
  Relay.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
    ),
    Layer.provide(
      Layer.mock(DesktopLinkService.DesktopLinkService)({
        getLinkForProject: () =>
          Effect.succeed(
            linked
              ? Option.some({
                  projectId,
                  hostId: host.hostId,
                  hostName: host.hostName,
                  winPath: "C:\\project",
                  serverPath: "/project",
                  createdAt: "now",
                })
              : Option.none(),
          ),
      }),
    ),
    Layer.provideMerge(Broker.layer),
    Layer.provideMerge(NodeServices.layer),
  );
export const startHost = Effect.fn(function* (input = host) {
  const broker = yield* Broker.DesktopChannelBroker;
  const output = yield* Queue.unbounded<DesktopChannelStreamEvent>();
  const fiber = yield* Stream.runForEach(
    yield* broker.connect(input, { subject: "owner", sessionId: AuthSessionId.make("auth") }),
    (event) => Queue.offer(output, event),
  ).pipe(Effect.forkScoped);
  const connected = yield* Queue.take(output);
  if (connected.type !== "connected") throw new Error("Expected connected");
  const identity = { hostId: input.hostId, connectionId: connected.connectionId };
  return {
    identity,
    next: Queue.take(output).pipe(
      Effect.map((event) => {
        if (event.type === "connected") throw new Error("Unexpected reconnect");
        return event;
      }),
    ),
    queued: Queue.size(output),
    stop: Fiber.interrupt(fiber),
    update: (capabilities: DesktopChannelHost["capabilities"]) =>
      broker.updateCapabilities({ ...identity, capabilities }),
    respond: (requestId: string, result: unknown) =>
      broker.respond({ ...identity, requestId, ok: true, result }),
    error: (requestId: string, code: string) =>
      broker.respond({
        ...identity,
        requestId,
        ok: false,
        error: { code, message: "local detail" },
      }),
    progress: (requestId: string) =>
      broker.emit({
        ...identity,
        requestId,
        seq: 0,
        events: [{ kind: "progress", data: '{"progress":1,"total":2,"message":"working"}' }],
      }),
  };
});
export const toolResult = {
  content: [{ type: "text", text: "done", localExtension: "preserved" }],
  isError: true,
};
