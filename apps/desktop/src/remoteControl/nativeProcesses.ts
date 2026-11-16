// @effect-diagnostics nodeBuiltinImport:off -- Native process environment and tree cleanup shared by desktop adapters.
import * as NodeChildProcess from "node:child_process";

/** Only pass a PID captured when this desktop process spawned the child. */
export const killWindowsProcessTree = (pid: number) =>
  NodeChildProcess.spawn("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
    windowsHide: true,
    stdio: "ignore",
  });

export function mergedEnvironment(
  overlay: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overlay)) {
    if (platform === "win32")
      for (const existing of Object.keys(env))
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    env[key] = value;
  }
  if (!Object.keys(env).some((key) => key.toUpperCase() === "PYTHONIOENCODING"))
    env.PYTHONIOENCODING = "utf-8";
  return env;
}
