import * as Schema from "effect/Schema";
import { ProjectId, IsoDateTime } from "./baseSchemas.ts";
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
