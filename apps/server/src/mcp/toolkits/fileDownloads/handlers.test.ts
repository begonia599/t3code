import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FileDownloadsToolkitHandlersLive } from "./handlers.ts";
import { FileDownloadsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-download-test");
const projectId = ProjectId.make("project-download-test");
const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-mcp-download-test-",
});

it.effect("shares a worktree artifact through a thread-bound relative download link", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-project-" });
    const worktree = path.join(projectRoot, "worktree");
    yield* fs.makeDirectory(worktree);
    const artifact = path.join(worktree, "preview.apk");
    yield* fs.writeFileString(artifact, "apk bytes");
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.secretsDir, { recursive: true });
    const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(
          id === threadId
            ? Option.some({ projectId, worktreePath: worktree } as OrchestrationThreadShell)
            : Option.none(),
        ),
      getProjectShellById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ workspaceRoot: projectRoot } as OrchestrationProjectShell)
            : Option.none(),
        ),
    });
    const toolkitDependencies = Layer.mergeAll(
      projectionLayer,
      ServerSecretStore.layer.pipe(Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config))),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const toolkit = yield* FileDownloadsToolkit.pipe(
      Effect.provide(FileDownloadsToolkitHandlersLive.pipe(Layer.provide(toolkitDependencies))),
    );
    const result = yield* toolkit.handle("share_file", { path: "preview.apk" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((items) => items.at(-1)?.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-download-test"),
        threadId,
        providerSessionId: "provider-session-download-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        issuedAt: 1,
      }),
      Effect.provide(toolkitDependencies),
    );
    expect(result).toMatchObject({
      fileName: "preview.apk",
      markdownLink: expect.stringMatching(/^\[preview\.apk\]\(<\/api\/assets\/[^>]+>\)$/),
    });
  }).pipe(Effect.provide(configLayer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.scoped),
);
