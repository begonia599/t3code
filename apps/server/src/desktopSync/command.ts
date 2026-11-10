import { MUTAGEN_VERSION } from "@t3tools/contracts";

/** Match the POSIX invocation emitted by Mutagen pkg/agent/dial.go, never shell syntax. */
export function parseCommand(command: string) {
  // pkg/logging/level.go spells the warning level "warn", not "warning".
  const match =
    /^\.mutagen\/agents\/(\d+\.\d+\.\d+)\/mutagen-agent synchronizer(?: (--log-level=(?:disabled|error|warn|info|debug|trace)))?$/.exec(
      command,
    );
  // JS `$` also matches before a final newline; require the entire string explicitly.
  if (!match || match[0] !== command) return { ok: false, code: "COMMAND_REJECTED" } as const;
  if (match[1] !== MUTAGEN_VERSION) return { ok: false, code: "VERSION_MISMATCH" } as const;
  return { ok: true, args: ["synchronizer", ...(match[2] ? [match[2]] : [])] } as const;
}
