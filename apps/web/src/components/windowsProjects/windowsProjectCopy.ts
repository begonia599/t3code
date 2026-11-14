import type { DesktopLinkError } from "@t3tools/contracts";

type DesktopLinkErrorCode = DesktopLinkError["code"];

/** English source copy for a failed Windows-folder action; translate before rendering. */
export interface WindowsProjectErrorCopy {
  readonly title: string;
  readonly description: string;
  /** The fix lives in Settings → Windows folders; offer a shortcut there. */
  readonly opensSettings?: boolean;
}

/** Settings anchor (section id and search target) for the Windows folders list. */
export const WINDOWS_FOLDERS_SETTINGS_ID = "windows-folders";

function findField<K extends "code" | "stage">(error: unknown, key: K): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const value = (current as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const SERVER_COPY: Partial<Record<DesktopLinkErrorCode, WindowsProjectErrorCopy>> = {
  HOST_NOT_CONNECTED: {
    title: "This PC isn't connected to the server",
    description: "Turn on remote control for this computer in Settings, then try again.",
    opensSettings: true,
  },
  HOST_SESSION_MISMATCH: {
    title: "This PC reconnected while setting up",
    description: "Try again in a moment.",
  },
  HOST_NOT_WINDOWS: {
    title: "Folders on this PC need the Windows app",
    description: "Open T3 Code on your Windows computer to add a folder from it.",
  },
  INVALID_WIN_PATH: {
    title: "This folder can't be synced",
    description: "Pick a regular folder on a local drive, not a drive root or network share.",
  },
  UNSAFE_PATH: {
    title: "This folder can't be synced",
    description: "Pick a regular folder on a local drive, not a drive root or network share.",
  },
};

/** Maps any error from `createWindowsProject` to what the user should know and do next. */
export function windowsProjectErrorCopy(error: unknown): WindowsProjectErrorCopy {
  const code = findField(error, "code") as DesktopLinkErrorCode | undefined;
  const known = code ? SERVER_COPY[code] : undefined;
  if (known) return known;
  switch (findField(error, "stage")) {
    case "picker":
      return {
        title: "Couldn't open the folder picker",
        description: "Restart T3 Code and try again.",
      };
    case "sync":
      return {
        title: "Project created, but syncing didn't start",
        description: "Choose Reconnect sync next to this folder in Settings.",
        opensSettings: true,
      };
    default:
      return {
        title: "Couldn't add the folder",
        description: "The server couldn't set up this folder. Try again.",
      };
  }
}
