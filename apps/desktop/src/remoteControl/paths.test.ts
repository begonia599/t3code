import { describe, expect, it } from "vite-plus/test";
import { normalizeRemoteControlConfig, normalizeWindowsPath, resolveWindowsCwd } from "./paths.ts";

const config = {
  allowlist: ["C:\\allowed", "\\\\server\\share"],
  mappings: [
    { serverPath: "/work", winPath: "D:\\work", syncSession: "root" },
    { serverPath: "/work/nested", winPath: "E:\\nested", syncSession: "nested" },
  ],
};
describe("Windows cwd", () => {
  it("uses the longest boundary mapping and recognizes explicit mapped cwd", () => {
    expect(resolveWindowsCwd({ serverCwd: "/work/nested/src" }, config)).toEqual({
      winCwd: "E:\\nested\\src",
      mapping: config.mappings[1],
    });
    expect(
      resolveWindowsCwd({ serverCwd: "/ignored", winCwd: "d:/WORK/src" }, config).mapping,
    ).toEqual(config.mappings[0]);
    expect(() => resolveWindowsCwd({ serverCwd: "/workspace" }, config)).toThrow(
      expect.objectContaining({ code: "CWD_NOT_MAPPED" }),
    );
  });
  it("normalizes traversal before checking case-insensitive boundary containment", () => {
    expect(resolveWindowsCwd({ serverCwd: "/", winCwd: "c:/ALLOWED/a/../b" }, config).winCwd).toBe(
      "c:\\ALLOWED\\b",
    );
    for (const winCwd of ["C:\\allowed-other", "C:\\allowed\\..\\secret", "C:relative", "\\rooted"])
      expect(() => resolveWindowsCwd({ serverCwd: "/", winCwd }, config)).toThrow(
        expect.objectContaining({ code: "CWD_NOT_ALLOWED" }),
      );
    expect(() => resolveWindowsCwd({ serverCwd: "/work/../secret" }, config)).toThrow(
      expect.objectContaining({ code: "CWD_NOT_MAPPED" }),
    );
  });
  it("accepts UNC and drive roots, rejects UNC siblings and malformed paths", () => {
    expect(
      resolveWindowsCwd({ serverCwd: "/", winCwd: "\\\\SERVER\\share\\dir" }, config).winCwd,
    ).toBe("\\\\SERVER\\share\\dir");
    expect(() =>
      resolveWindowsCwd({ serverCwd: "/", winCwd: "\\\\server\\share2" }, config),
    ).toThrow();
    expect(normalizeWindowsPath("C:/")).toBe("C:\\");
    for (const invalid of ["foo", "/root", "C:foo", "C:\\a\0", "C:\\a:stream", "\\\\?\\C:\\a"])
      expect(() => normalizeWindowsPath(invalid)).toThrow();
  });
  it("normalizes, deduplicates, and validates settings", () => {
    expect(
      normalizeRemoteControlConfig({
        allowlist: ["C:/a/", "c:\\a"],
        mappings: [
          { serverPath: "/work/", winPath: "D:/work/" },
          { serverPath: "/work", winPath: "D:/new" },
        ],
      }),
    ).toEqual({ allowlist: ["c:\\a"], mappings: [{ serverPath: "/work", winPath: "D:\\new" }] });
    expect(() =>
      normalizeRemoteControlConfig({ mappings: [{ serverPath: "relative", winPath: "C:\\a" }] }),
    ).toThrow("POSIX");
    expect(() => normalizeRemoteControlConfig({ allowlist: ["relative"] })).toThrow("Windows");
    expect(normalizeRemoteControlConfig({})).toEqual({});
  });
});

it("derives paths only for the owning environment without changing manual config", () => {
  const linkedProjects = [
    {
      id: "link",
      environmentId: "env",
      projectId: "project",
      hostId: "host",
      serverPath: "/linked",
      winPath: "W:\\linked",
      syncSession: "link-session",
      paused: false,
      createdAt: "2026-11-14T00:00:00Z",
    },
  ] as unknown as readonly import("@t3tools/contracts").DesktopLinkedFolder[];
  const combined = { ...config, linkedProjects };
  expect(
    resolveWindowsCwd({ serverCwd: "/linked/src", environmentId: "env" }, combined).winCwd,
  ).toBe("W:\\linked\\src");
  expect(
    resolveWindowsCwd({ serverCwd: "/", winCwd: "w:\\LINKED", environmentId: "env" }, combined)
      .mapping?.syncSession,
  ).toBe("link-session");
  expect(() =>
    resolveWindowsCwd({ serverCwd: "/linked", environmentId: "other" }, combined),
  ).toThrow();
  expect(() =>
    resolveWindowsCwd({ serverCwd: "/", winCwd: "W:\\linked", environmentId: "other" }, combined),
  ).toThrow();
  expect(resolveWindowsCwd({ serverCwd: "/work", environmentId: "other" }, combined).winCwd).toBe(
    "D:\\work",
  );
  expect(combined.mappings).toHaveLength(2);
  expect(combined.allowlist).toEqual(config.allowlist);
});
