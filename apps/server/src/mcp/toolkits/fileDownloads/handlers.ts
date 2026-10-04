import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { issueAgentDownloadUrl } from "../../../assets/AssetAccess.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { isProviderPathVisible } from "../../../provider/ProviderFileAccess.ts";
import {
  FileDownloadsToolkit,
  FileShareFailedError,
  FileShareFileNotFoundError,
  FileShareThreadNotFoundError,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const path = yield* Path.Path;

  return FileDownloadsToolkit.of({
    share_file: (input) =>
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const thread = yield* snapshots
          .getThreadShellById(invocation.threadId)
          .pipe(Effect.mapError((cause) => new FileShareFailedError({ cause })));
        if (Option.isNone(thread)) return yield* new FileShareThreadNotFoundError({});
        const project = yield* snapshots
          .getProjectShellById(thread.value.projectId)
          .pipe(Effect.mapError((cause) => new FileShareFailedError({ cause })));
        if (Option.isNone(project)) return yield* new FileShareThreadNotFoundError({});

        const requestedPath = path.resolve(
          thread.value.worktreePath ?? project.value.workspaceRoot,
          input.path,
        );
        const visible = yield* isProviderPathVisible(
          invocation.allowedFileRoots,
          requestedPath,
        ).pipe(Effect.orElseSucceed(() => false));
        if (!visible) return yield* new FileShareFileNotFoundError({ path: input.path });
        const issued = yield* issueAgentDownloadUrl(requestedPath).pipe(
          Effect.mapError((cause) => new FileShareFailedError({ cause })),
        );
        if (issued === null) {
          return yield* new FileShareFileNotFoundError({ path: input.path });
        }
        const label = issued.fileName
          .replaceAll("\\", "\\\\")
          .replaceAll("[", "\\[")
          .replaceAll("]", "\\]");
        return {
          fileName: issued.fileName,
          relativeUrl: issued.relativeUrl,
          markdownLink: `[${label}](<${issued.relativeUrl}>)`,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(issued.expiresAt)),
        };
      }),
  });
});

export const FileDownloadsToolkitHandlersLive = FileDownloadsToolkit.toLayer(make);
