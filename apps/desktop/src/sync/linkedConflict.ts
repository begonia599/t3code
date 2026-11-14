// @effect-diagnostics nodeBuiltinImport:off -- Native conflict deletion uses lstat and canonical parent containment.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Remove the selected conflict entry; symlinks are unlinked rather than followed. */
export async function removeWindowsConflict(winPath: string, relative: string) {
  const segments = relative.replaceAll("\\", "/").split("/");
  if (
    !relative ||
    NodePath.win32.isAbsolute(relative) ||
    NodePath.posix.isAbsolute(relative) ||
    relative.includes(":") ||
    relative.includes("\0") ||
    segments.some((segment) => !segment || segment === ".." || segment === ".") ||
    segments[0]?.toLowerCase() === ".git"
  )
    throw new Error("Invalid relative conflict path");
  const root = await NodeFSP.realpath(winPath);
  const target = NodePath.resolve(root, ...segments);
  const within = (path: string) => {
    const relative = NodePath.relative(root, path);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative)
    );
  };
  if (!within(target)) throw new Error("Conflict path escapes linked folder");
  try {
    const parent = await NodeFSP.realpath(NodePath.dirname(target));
    if (!within(parent)) throw new Error("Conflict parent escapes linked folder");
    const stat = await NodeFSP.lstat(target);
    if (stat.isDirectory()) await NodeFSP.rm(target, { recursive: true, force: true });
    else await NodeFSP.unlink(target);
  } catch (error) {
    if (!(typeof error === "object" && error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
