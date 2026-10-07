import * as Effect from "effect/Effect";

import * as FileDownloads from "../../../assets/FileDownloads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FileDownloadsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const downloads = yield* FileDownloads.FileDownloads;
  return FileDownloadsToolkit.of({
    share_file: (input) =>
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.requireMcpCapability("file-downloads");
        return yield* downloads.share({ threadId: invocation.threadId, path: input.path });
      }),
  });
});

export const FileDownloadsToolkitHandlersLive = FileDownloadsToolkit.toLayer(make);
