import { type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { issueAgentDownloadUrl } from "./AssetAccess.ts";

export class FileShareThreadNotFoundError extends Schema.TaggedError<FileShareThreadNotFoundError>()(
  "FileShareThreadNotFoundError",
  {},
) {
  override get message(): string {
    return "The current thread or its project is no longer available.";
  }
}

export class FileShareFileNotFoundError extends Schema.TaggedError<FileShareFileNotFoundError>()(
  "FileShareFileNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `No readable regular file exists at ${this.path}.`;
  }
}

export class FileShareFailedError extends Schema.TaggedError<FileShareFailedError>()(
  "FileShareFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not create a file download link.";
  }
}

export const FileDownloadLink = Schema.Struct({
  fileName: Schema.String,
  relativeUrl: Schema.String,
  markdownLink: Schema.String,
  expiresAt: Schema.String,
});

export class FileDownloads extends Context.Service<
  FileDownloads,
  {
    readonly share: (input: {
      readonly threadId: ThreadId;
      readonly path: string;
    }) => Effect.Effect<
      typeof FileDownloadLink.Type,
      FileShareThreadNotFoundError | FileShareFileNotFoundError | FileShareFailedError
    >;
  }
>()("t3/assets/FileDownloads") {}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const share = Effect.fn("FileDownloads.share")(function* (input: {
    readonly threadId: ThreadId;
    readonly path: string;
  }) {
    const thread = yield* snapshots
      .getThreadShellById(input.threadId)
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
    const issued = yield* issueAgentDownloadUrl(requestedPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.mapError((cause) => new FileShareFailedError({ cause })),
    );
    if (issued === null) return yield* new FileShareFileNotFoundError({ path: input.path });
    // Collapse line breaks so unusual file names still produce one Markdown link.
    const label = issued.fileName.replace(/[\r\n]+/g, " ").replace(/[\\[\]]/g, "\\$&");
    return {
      fileName: issued.fileName,
      relativeUrl: issued.relativeUrl,
      markdownLink: `[${label}](<${issued.relativeUrl}>)`,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(issued.expiresAt)),
    };
  });
  return FileDownloads.of({ share });
});

export const layer = Layer.effect(FileDownloads, make);
