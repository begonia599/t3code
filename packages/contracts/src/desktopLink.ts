import * as Schema from "effect/Schema";
import { ProjectId, IsoDateTime, EnvironmentId } from "./baseSchemas.ts";
import { DesktopChannelHost } from "./desktopChannel.ts";

export const DesktopLinkedProject = Schema.Struct({
  projectId: ProjectId,
  hostId: DesktopChannelHost.fields.hostId,
  hostName: Schema.String,
  winPath: Schema.String,
  serverPath: Schema.String,
  createdAt: IsoDateTime,
});
export type DesktopLinkedProject = typeof DesktopLinkedProject.Type;

export class DesktopLinkError extends Schema.TaggedError<DesktopLinkError>()("DesktopLinkError", {
  code: Schema.Literals([
    "HOST_NOT_CONNECTED",
    "HOST_NOT_WINDOWS",
    "HOST_SESSION_MISMATCH",
    "INVALID_WIN_PATH",
    "INVALID_CONFLICT_PATH",
    "NOT_LINKED",
    "UNSAFE_PATH",
    "CREATE_FAILED",
  ]),
  message: Schema.String,
}) {}

/** Desktop-local authority for mapping and authorizing a linked folder. */
export const DesktopLinkedFolder = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  hostId: DesktopChannelHost.fields.hostId,
  serverPath: Schema.String,
  winPath: Schema.String,
  syncSession: Schema.String,
  paused: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type DesktopLinkedFolder = typeof DesktopLinkedFolder.Type;

export const LinkedSyncStatus = Schema.Struct({
  linkId: Schema.String,
  state: Schema.Literals([
    "initial",
    "synced",
    "syncing",
    "conflicts",
    "disconnected",
    "paused",
    "error",
  ]),
  conflicts: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      alpha: Schema.optional(Schema.Unknown),
      beta: Schema.optional(Schema.Unknown),
    }),
  ),
  message: Schema.optional(Schema.String),
  lastSyncedAt: Schema.optional(Schema.String),
});
export type LinkedSyncStatus = typeof LinkedSyncStatus.Type;

export const RegisterLinkedProject = Schema.Struct({
  environmentId: EnvironmentId,
  link: DesktopLinkedProject,
});
export const LinkedProjectId = Schema.Struct({ id: Schema.String.check(Schema.isUUID()) });
export const ResolveLinkedConflict = Schema.Struct({
  ...LinkedProjectId.fields,
  path: Schema.String,
  keep: Schema.Literal("server"),
});
export interface LinkedProjectsBridge {
  pickFolder(): Promise<string | null>;
  register(input: typeof RegisterLinkedProject.Type): Promise<DesktopLinkedFolder>;
  list(): Promise<DesktopLinkedFolder[]>;
  getStatuses(): Promise<LinkedSyncStatus[]>;
  onStatusChanged(listener: (statuses: readonly LinkedSyncStatus[]) => void): () => void;
  onChanged(listener: (records: readonly DesktopLinkedFolder[]) => void): () => void;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  flush(id: string): Promise<void>;
  resolveConflict(input: typeof ResolveLinkedConflict.Type): Promise<void>;
}
