// @effect-diagnostics nodeBuiltinImport:off -- Pure Windows path operations must work on Linux too.
import * as NodePath from "node:path";
import type {
  DesktopExecInput,
  DesktopPathMapping,
  RemoteControlConfigPatch,
} from "@t3tools/contracts";

export function normalizeWindowsPath(value: string): string {
  const normalized = NodePath.win32.normalize(value.replaceAll("/", "\\"));
  if (
    !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(normalized) ||
    /[\0<>"|?*]/.test(normalized) ||
    normalized.slice(/^[a-z]:/i.test(normalized) ? 2 : 0).includes(":")
  ) {
    throw new Error(`Expected an absolute Windows drive or UNC path: ${value}`);
  }
  // A drive root must retain its separator: C: means the drive's current directory.
  return normalized.replace(/\\+$/, "") + (/^[a-z]:\\$/i.test(normalized) ? "\\" : "");
}

export function normalizeRemoteControlConfig(patch: RemoteControlConfigPatch) {
  const allowlist =
    patch.allowlist === undefined
      ? undefined
      : [
          ...new Map(
            patch.allowlist.map((p) => {
              const normalized = normalizeWindowsPath(p);
              return [normalized.toLowerCase(), normalized] as const;
            }),
          ).values(),
        ];
  const mappings =
    patch.mappings === undefined
      ? undefined
      : [
          ...new Map(
            patch.mappings.map((mapping) => {
              if (
                !NodePath.posix.isAbsolute(mapping.serverPath) ||
                mapping.serverPath.includes("\0")
              )
                throw new Error(`Expected an absolute POSIX serverPath: ${mapping.serverPath}`);
              const serverPath =
                NodePath.posix.normalize(mapping.serverPath).replace(/\/+$/, "") || "/";
              const winPath = normalizeWindowsPath(mapping.winPath);
              const syncSession = mapping.syncSession?.trim();
              if (mapping.syncSession !== undefined && !syncSession)
                throw new Error("syncSession cannot be empty");
              return [
                serverPath,
                { serverPath, winPath, ...(syncSession ? { syncSession } : {}) },
              ] as const;
            }),
          ).values(),
        ];
  return {
    ...(allowlist === undefined ? {} : { allowlist }),
    ...(mappings === undefined ? {} : { mappings }),
    ...(patch.strictMode === undefined ? {} : { strictMode: patch.strictMode }),
  };
}

export function withinWindowsPath(candidate: string, root: string) {
  const relative = NodePath.win32.relative(root.toLowerCase(), candidate.toLowerCase());
  return (
    relative === "" ||
    (!NodePath.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"))
  );
}

export function resolveWindowsCwd(
  input: Pick<DesktopExecInput, "winCwd" | "serverCwd">,
  config: {
    readonly allowlist: readonly string[];
    readonly mappings: readonly DesktopPathMapping[];
  },
) {
  let mapping: DesktopPathMapping | undefined;
  let candidate = input.winCwd;
  if (candidate === undefined) {
    const serverCwd = NodePath.posix.normalize(input.serverCwd);
    mapping = config.mappings
      .filter(
        (m) =>
          serverCwd === m.serverPath ||
          serverCwd.startsWith(m.serverPath === "/" ? "/" : `${m.serverPath}/`),
      )
      .sort((a, b) => b.serverPath.length - a.serverPath.length)[0];
    if (!mapping) throw { code: "CWD_NOT_MAPPED", message: `No mapping for ${input.serverCwd}` };
    candidate = NodePath.win32.join(
      mapping.winPath,
      NodePath.posix.relative(mapping.serverPath, serverCwd).replaceAll("/", "\\"),
    );
  }
  let winCwd: string;
  try {
    winCwd = normalizeWindowsPath(candidate);
  } catch (error) {
    throw { code: "CWD_NOT_ALLOWED", message: String(error) };
  }
  const effectiveAllowlist = [...config.allowlist, ...config.mappings.map((m) => m.winPath)];
  if (!effectiveAllowlist.some((root) => withinWindowsPath(winCwd, root)))
    throw { code: "CWD_NOT_ALLOWED", message: `Directory is outside the allowlist: ${winCwd}` };
  if (input.winCwd !== undefined)
    mapping = config.mappings
      .filter((m) => withinWindowsPath(winCwd, m.winPath))
      .sort((a, b) => b.winPath.length - a.winPath.length)[0];
  return { winCwd, mapping };
}
