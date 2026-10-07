import type { EnvironmentId, NativeConfigTarget } from "@t3tools/contracts";
import { createNativeConfigEditor } from "@t3tools/client-runtime/state/nativeConfig";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function useNativeConfigEditor(environmentId: EnvironmentId, target: NativeConfigTarget) {
  const list = useAtomCommand(serverEnvironment.nativeConfigList, { reportFailure: false });
  const read = useAtomCommand(serverEnvironment.nativeConfigRead, { reportFailure: false });
  const preview = useAtomCommand(serverEnvironment.nativeConfigPreview, { reportFailure: false });
  const write = useAtomCommand(serverEnvironment.nativeConfigWrite, { reportFailure: false });
  const undo = useAtomCommand(serverEnvironment.nativeConfigUndo, { reportFailure: false });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const { instanceId, cwd } = target;
  const editor = useMemo(() => {
    const unwrap = async <A, E>(promise: Promise<AtomCommandResult<A, E>>) => {
      const result = await promise;
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      return result.value;
    };
    return createNativeConfigEditor(
      { instanceId, ...(cwd ? { cwd } : {}) },
      {
        list: (input) => unwrap(list({ environmentId, input })),
        read: (input) => unwrap(read({ environmentId, input })),
        preview: (input) => unwrap(preview({ environmentId, input })),
        write: (input) => unwrap(write({ environmentId, input })),
        undo: (input) => unwrap(undo({ environmentId, input })),
        refresh: async (input) => {
          await unwrap(refresh({ environmentId, input: { ...input, fresh: true } }));
        },
      },
    );
  }, [environmentId, instanceId, cwd, list, read, preview, write, undo, refresh]);
  useEffect(() => {
    void editor.load();
    return () => editor.dispose();
  }, [editor]);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  return { editor, state };
}
