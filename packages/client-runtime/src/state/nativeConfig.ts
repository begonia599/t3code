import type {
  NativeConfigDocument,
  NativeConfigList,
  NativeConfigTarget,
  NativeConfigReadInput,
  NativeConfigWriteInput,
  NativeConfigWriteResult,
  NativeConfigUndoInput,
} from "@t3tools/contracts";

interface NativeConfigActions {
  readonly list: (input: NativeConfigTarget) => Promise<NativeConfigList>;
  readonly read: (input: NativeConfigReadInput) => Promise<NativeConfigDocument>;
  readonly preview: (input: NativeConfigWriteInput) => Promise<string>;
  readonly write: (input: NativeConfigWriteInput) => Promise<NativeConfigWriteResult>;
  readonly undo: (input: NativeConfigUndoInput) => Promise<NativeConfigDocument>;
  readonly refresh: (input: NativeConfigTarget) => Promise<void>;
}

export interface NativeConfigEditorState {
  readonly catalog: NativeConfigList | null;
  readonly document: NativeConfigDocument | null;
  readonly draft: string;
  readonly diff: string | null;
  readonly undoToken: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}

/** In-memory editor state shared by web and mobile; drafts never enter caches. */
export function createNativeConfigEditor(target: NativeConfigTarget, actions: NativeConfigActions) {
  let state: NativeConfigEditorState = {
    catalog: null,
    document: null,
    draft: "",
    diff: null,
    undoToken: null,
    busy: false,
    error: null,
    notice: null,
  };
  const listeners = new Set<() => void>();
  let generation = 0;
  const update = (patch: Partial<NativeConfigEditorState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const dirty = () => state.document !== null && state.draft !== state.document.content;
  const catalogWith = (document: NativeConfigDocument) =>
    state.catalog
      ? {
          ...state.catalog,
          files: state.catalog.files.map((file) =>
            file.path === document.file.path ? document.file : file,
          ),
        }
      : null;
  const run = async (action: () => Promise<Partial<NativeConfigEditorState>>) => {
    if (state.busy) return;
    const request = ++generation;
    update({ busy: true, error: null, notice: null });
    try {
      const result = await action();
      if (request === generation) update(result);
    } catch (cause) {
      if (request === generation)
        update({
          error: cause instanceof Error ? cause.message : "The configuration operation failed.",
        });
    } finally {
      if (request === generation) update({ busy: false });
    }
  };
  const writeInput = (): NativeConfigWriteInput | null =>
    state.document
      ? {
          ...target,
          path: state.document.file.path,
          revision: state.document.revision,
          content: state.draft,
        }
      : null;
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dirty,
    dispose: () => {
      generation++;
      state = { ...state, busy: false };
    },
    load: () => run(async () => ({ catalog: await actions.list(target) })),
    refreshSkills: () =>
      run(async () => {
        await actions.refresh(target);
        return {
          notice: "Skills discovery refreshed. Loading in the running session is not confirmed.",
        };
      }),
    open: (path: string) => {
      if (dirty()) return Promise.resolve();
      return run(async () => {
        const document = await actions.read({ ...target, path });
        return {
          document,
          catalog: catalogWith(document),
          draft: document.content,
          diff: null,
          undoToken: null,
        };
      });
    },
    edit: (draft: string) => {
      if (!state.busy) update({ draft, diff: null, notice: null, error: null });
    },
    discard: () => {
      if (!state.busy) update({ draft: state.document?.content ?? "", diff: null, error: null });
    },
    reload: () => {
      const document = state.document;
      const draft = state.draft;
      const hadChanges = dirty();
      return document
        ? run(async () => {
            const latest = await actions.read({ ...target, path: document.file.path });
            return {
              document: latest,
              catalog: catalogWith(latest),
              draft: hadChanges ? draft : latest.content,
              diff: null,
              undoToken: null,
              notice: hadChanges
                ? "Reloaded the saved file and kept your draft. Review the differences before saving."
                : null,
            };
          })
        : Promise.resolve();
    },
    preview: () => {
      const input = writeInput();
      return input ? run(async () => ({ diff: await actions.preview(input) })) : Promise.resolve();
    },
    save: () => {
      const input = writeInput();
      return input
        ? run(async () => {
            const result = await actions.write(input);
            return {
              document: result.document,
              catalog: catalogWith(result.document),
              draft: result.document.content,
              undoToken: result.undoToken,
              diff: null,
              notice: "Saved to the native file. Loading in the running session is not confirmed.",
            };
          })
        : Promise.resolve();
    },
    undo: () => {
      const undoToken = state.undoToken;
      if (!undoToken || dirty()) return Promise.resolve();
      return run(async () => {
        const document = await actions.undo({ undoToken });
        return {
          document,
          catalog: catalogWith(document),
          draft: document.content,
          undoToken: null,
          diff: null,
          notice: "The previous file contents were restored.",
        };
      });
    },
  };
}
