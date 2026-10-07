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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as FileDownloads from "../../../assets/FileDownloads.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FileDownloadsToolkitHandlersLive } from "./handlers.ts";
import { FileDownloadsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-download-test");
const projectId = ProjectId.make("project-download-test");
const decodeFileDownloadLink = Schema.decodeUnknownEffect(FileDownloads.FileDownloadLink);
const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-mcp-download-test-",
});

it.effect("rejects a preview-only credential before accessing any file", () =>
  Effect.gen(function* () {
    const toolkit = yield* FileDownloadsToolkit.pipe(
      Effect.provide(
        FileDownloadsToolkitHandlersLive.pipe(
          Layer.provide(
            Layer.mock(FileDownloads.FileDownloads)({
              share: () => Effect.die("File access must not occur without the download capability"),
            }),
          ),
        ),
      ),
    );
    const result = yield* toolkit.handle("share_file", { path: "report.zip" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((items) => items.at(-1)?.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-download-test"),
        threadId,
        providerSessionId: "provider-session-download-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["preview"]),
        issuedAt: 1,
      }),
      Effect.flip,
    );
    expect(result).toMatchObject({
      _tag: "McpCapabilityUnavailableError",
      capability: "file-downloads",
      threadId,
    });
  }),
);

it.effect.each(["worktree", "project", "absolute"] as const)(
  "shares a %s artifact through a thread-bound relative download link",
  (location) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-project-" });
      const worktree = path.join(projectRoot, "worktree");
      yield* fs.makeDirectory(worktree);
      const fileName = "导出 [preview].apk";
      const artifact = path.join(location === "worktree" ? worktree : projectRoot, fileName);
      yield* fs.writeFileString(artifact, "apk bytes");
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: (id) =>
          Effect.succeed(
            id === threadId
              ? Option.some({
                  projectId,
                  worktreePath: location === "project" ? null : worktree,
                } as OrchestrationThreadShell)
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
        ServerSecretStore.layer.pipe(
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      const toolkit = yield* FileDownloadsToolkit.pipe(
        Effect.provide(
          FileDownloadsToolkitHandlersLive.pipe(
            Layer.provide(FileDownloads.layer),
            Layer.provide(toolkitDependencies),
          ),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const result = yield* toolkit
        .handle("share_file", { path: location === "absolute" ? artifact : fileName })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((items) => items.at(-1)?.result),
          Effect.flatMap(decodeFileDownloadLink),
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-download-test"),
            threadId,
            providerSessionId: "provider-session-download-test",
            providerInstanceId: ProviderInstanceId.make("codex"),
            capabilities: new Set<McpInvocationContext.McpCapability>(["file-downloads"]),
            issuedAt: 1,
          }),
          Effect.provide(toolkitDependencies),
        );
      expect(result).toMatchObject({
        fileName,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 24 * 60 * 60 * 1000)),
      });
      expect(result.markdownLink).toBe(`[导出 \\[preview\\].apk](<${result.relativeUrl}>)`);
      expect(result.relativeUrl).toMatch(/^\/api\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\//);
      expect(result.relativeUrl.endsWith(encodeURIComponent(fileName))).toBe(true);
    }).pipe(
      Effect.provide(configLayer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

it.effect.each(["thread", "project", "file", "directory"] as const)(
  "reports a missing %s without issuing a link",
  (missing) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-missing-" });
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      const dependencies = Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            Effect.succeed(
              missing === "thread"
                ? Option.none()
                : Option.some({ projectId, worktreePath: null } as OrchestrationThreadShell),
            ),
          getProjectShellById: () =>
            Effect.succeed(
              missing === "project"
                ? Option.none()
                : Option.some({ workspaceRoot: root } as OrchestrationProjectShell),
            ),
        }),
        ServerSecretStore.layer.pipe(
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      const error = yield* Effect.gen(function* () {
        const downloads = yield* FileDownloads.FileDownloads;
        return yield* downloads
          .share({ threadId, path: missing === "directory" ? "." : "missing.zip" })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(FileDownloads.layer.pipe(Layer.provide(dependencies))));
      expect(error._tag).toBe(
        missing === "thread" || missing === "project"
          ? "FileShareThreadNotFoundError"
          : "FileShareFileNotFoundError",
      );
    }).pipe(
      Effect.provide(configLayer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);
