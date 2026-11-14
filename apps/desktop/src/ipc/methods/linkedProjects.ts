import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DesktopLinkedFolder,
  LinkedSyncStatus,
  LinkedProjectId,
  RegisterLinkedProject,
  ResolveLinkedConflict,
} from "@t3tools/contracts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { ElectronDialog } from "../../electron/ElectronDialog.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { LinkedProjects } from "../../sync/LinkedProjects.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class LinkedProjectsIpcError extends Schema.TaggedError<LinkedProjectsIpcError>()(
  "LinkedProjectsIpcError",
  { message: Schema.String },
) {}
const nativeCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LinkedProjectsIpcError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const pickFolder = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_PICK_FOLDER_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn(function* () {
    if ((yield* DesktopEnvironment).platform !== "win32") return null;
    const dialog = yield* ElectronDialog;
    const windows = yield* ElectronWindow;
    return Option.getOrNull(
      yield* dialog.pickFolder({
        owner: yield* windows.currentMainOrFirst,
        defaultPath: Option.none(),
      }),
    );
  }),
});
export const register = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_REGISTER_CHANNEL,
  payload: RegisterLinkedProject,
  result: DesktopLinkedFolder,
  handler: Effect.fn(function* (input) {
    const service = yield* LinkedProjects;
    return yield* nativeCall(() => service.register(input));
  }),
});
export const list = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopLinkedFolder),
  handler: Effect.fn(function* () {
    const service = yield* LinkedProjects;
    return yield* nativeCall(() => service.list());
  }),
});
export const getStatuses = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_GET_STATUSES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(LinkedSyncStatus),
  handler: Effect.fn(function* () {
    const service = yield* LinkedProjects;
    return yield* nativeCall(() => service.getStatuses());
  }),
});
export const pause = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_PAUSE_CHANNEL,
  payload: LinkedProjectId,
  result: Schema.Void,
  handler: Effect.fn(function* ({ id }) {
    const service = yield* LinkedProjects;
    yield* nativeCall(() => service.pause(id));
  }),
});
export const resume = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_RESUME_CHANNEL,
  payload: LinkedProjectId,
  result: Schema.Void,
  handler: Effect.fn(function* ({ id }) {
    const service = yield* LinkedProjects;
    yield* nativeCall(() => service.resume(id));
  }),
});
export const remove = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_REMOVE_CHANNEL,
  payload: LinkedProjectId,
  result: Schema.Void,
  handler: Effect.fn(function* ({ id }) {
    const service = yield* LinkedProjects;
    yield* nativeCall(() => service.remove(id));
  }),
});
export const flush = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_FLUSH_CHANNEL,
  payload: LinkedProjectId,
  result: Schema.Void,
  handler: Effect.fn(function* ({ id }) {
    const service = yield* LinkedProjects;
    yield* nativeCall(() => service.flush(id));
  }),
});
export const resolveConflict = makeIpcMethod({
  channel: Channels.LINKED_PROJECTS_RESOLVE_CONFLICT_CHANNEL,
  payload: ResolveLinkedConflict,
  result: Schema.Void,
  handler: Effect.fn(function* (input) {
    const service = yield* LinkedProjects;
    yield* nativeCall(() => service.resolveConflict(input));
  }),
});
