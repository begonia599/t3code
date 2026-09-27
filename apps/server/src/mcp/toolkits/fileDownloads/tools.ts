import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";

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

export const FileDownloadsToolkit = Toolkit.make(
  Tool.make("share_file", {
    description:
      "Create a 24-hour download link for one completed file on this environment host. Use this when the user asks to download an artifact, including files too large for chat attachments. Pass an absolute path or a path relative to this thread's workspace. Copy the returned markdownLink into your reply so each T3 Code client opens the file from its own environment connection. Anyone with the link can download the file until it expires; use only for files the user wants to share.",
    parameters: Schema.Struct({
      path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)).annotate({
        description: "Absolute file path or path relative to this thread's workspace.",
      }),
    }),
    success: Schema.Struct({
      fileName: Schema.String,
      relativeUrl: Schema.String,
      markdownLink: Schema.String,
      expiresAt: Schema.String,
    }),
    failure: Schema.Union([
      FileShareThreadNotFoundError,
      FileShareFileNotFoundError,
      FileShareFailedError,
    ]),
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      FileSystem.FileSystem,
      Path.Path,
      ServerSecretStore.ServerSecretStore,
    ],
  })
    .annotate(Tool.Title, "Share file for download")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true),
);
