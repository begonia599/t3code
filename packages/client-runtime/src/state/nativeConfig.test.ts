import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type NativeConfigDocument,
  type NativeConfigList,
} from "@t3tools/contracts";
import { createNativeConfigEditor } from "./nativeConfig.ts";

const document: NativeConfigDocument = {
  file: {
    path: "/fixture/config.toml",
    scope: "user",
    kind: "settings",
    format: "toml",
    exists: true,
    writable: true,
    problem: null,
  },
  resolvedPath: "/fixture/config.toml",
  revision: "first",
  content: "# original",
};
const catalog: NativeConfigList = {
  driver: "codex",
  homePath: "/fixture",
  files: [document.file],
  truncated: false,
  hasLaunchOverrides: false,
  environmentOverrides: [],
};
function setup(overrides: Partial<Parameters<typeof createNativeConfigEditor>[1]> = {}) {
  return createNativeConfigEditor(
    { instanceId: ProviderInstanceId.make("codex") },
    {
      list: async () => catalog,
      read: async () => document,
      preview: async () => "-old\n+new",
      write: async (input) => ({
        document: { ...document, revision: "second", content: input.content },
        undoToken: "undo-1",
      }),
      undo: async () => document,
      refresh: async () => {},
      ...overrides,
    },
  );
}
describe("native editor lifecycle", () => {
  it("keeps the draft on conflict and blocks accidental file switches", async () => {
    const editor = setup({
      write: async () => {
        throw new Error("external change");
      },
    });
    await editor.load();
    await editor.open(document.file.path);
    editor.edit("# draft");
    await editor.open("/another");
    expect(editor.getSnapshot().document?.file.path).toBe(document.file.path);
    await editor.save();
    expect(editor.getSnapshot().draft).toBe("# draft");
    expect(editor.getSnapshot().error).toBe("external change");
    expect(editor.dirty()).toBe(true);
  });
  it("reloads externally changed content without discarding the draft", async () => {
    let current = document;
    let writtenRevision: string | null = null;
    const editor = setup({
      read: async () => current,
      write: async (input) => {
        writtenRevision = input.revision;
        return { document: { ...current, content: input.content }, undoToken: "undo" };
      },
    });
    await editor.open(document.file.path);
    editor.edit("# draft");
    current = { ...document, content: "# external", revision: "external" };
    await editor.reload();
    expect(editor.getSnapshot().draft).toBe("# draft");
    expect(editor.getSnapshot().document?.content).toBe("# external");
    await editor.save();
    expect(writtenRevision).toBe("external");
  });
  it("clears obsolete previews, saves and undoes without overwriting a dirty draft", async () => {
    const editor = setup();
    await editor.open(document.file.path);
    editor.edit("# draft");
    await editor.preview();
    expect(editor.getSnapshot().diff).toContain("+new");
    editor.edit("# later");
    expect(editor.getSnapshot().diff).toBeNull();
    await editor.save();
    expect(editor.dirty()).toBe(false);
    editor.edit("# pending");
    await editor.undo();
    expect(editor.getSnapshot().draft).toBe("# pending");
    editor.discard();
    await editor.undo();
    expect(editor.getSnapshot().draft).toBe(document.content);
    expect(editor.getSnapshot().undoToken).toBeNull();
  });
  it("ignores a disposed request and can load again after effect cleanup", async () => {
    let finish: (value: NativeConfigList) => void = () => {};
    const editor = setup({
      list: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = editor.load();
    editor.dispose();
    finish(catalog);
    await pending;
    expect(editor.getSnapshot().catalog).toBeNull();
    expect(editor.getSnapshot().busy).toBe(false);
    const next = editor.load();
    finish(catalog);
    await next;
    expect(editor.getSnapshot().catalog).toBe(catalog);
  });
});
