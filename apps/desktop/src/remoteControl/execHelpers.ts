// @effect-diagnostics nodeBuiltinImport:off -- Pure Windows path operations must work on Linux too.
import * as NodePath from "node:path";
import { DESKTOP_EXEC_SUMMARY_MAX_CHARS, type DesktopExecInput } from "@t3tools/contracts";

export const commandSummary = (input: DesktopExecInput) =>
  (input.mode === "argv"
    ? input.argv.map((a) => (/\s|"/.test(a) || !a.length ? JSON.stringify(a) : a)).join(" ")
    : input.script
  ).slice(0, DESKTOP_EXEC_SUMMARY_MAX_CHARS);

/** Pure candidate generation; the caller checks which candidates are executable files. */
export function windowsExecutableCandidates(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const value = (name: string) =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const extensions = (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const suffixes = hasExtension ? [""] : extensions;
  const dirs = /[\\/:]/.test(command)
    ? [cwd]
    : [
        cwd,
        ...(value("PATH") ?? "")
          .split(";")
          .filter(Boolean)
          .map((s) => s.replace(/^"(.*)"$/, "$1")),
      ];
  return dirs.flatMap((dir) =>
    suffixes.map((ext) => NodePath.win32.resolve(cwd, dir, command + ext)),
  );
}

const meta = /([()\][%!^"`<>&|;, *?])/g;
export const escapeCmdCommand = (command: string) => command.replace(meta, "^$1");
/** cross-spawn's CRT quoting followed by cmd metacharacter escaping. */
export function escapeCmdArgument(argument: string, doubleEscape = false) {
  const parts: string[] = [];
  let backslashes = 0;
  for (const char of argument) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    parts.push("\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes), char);
    backslashes = 0;
  }
  parts.push("\\".repeat(backslashes * 2));
  let escaped = parts.join("");
  escaped = `"${escaped}"`.replace(meta, "^$1");
  return doubleEscape ? escaped.replace(meta, "^$1") : escaped;
}
export function cmdCommandLine(executable: string, args: readonly string[]) {
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  return `"${[escapeCmdCommand(executable), ...args.map((a) => escapeCmdArgument(a, doubleEscape))].join(" ")}"`;
}

/** Keep incomplete UTF-8 bytes ourselves so a failing decode can replay every byte as GBK. */
export function createOutputDecoder() {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const gbk = new TextDecoder("gbk");
  let pending = Buffer.alloc(0);
  let fallback = false;
  return {
    get decodedAsGbk() {
      return fallback;
    },
    decode(chunk: Buffer = Buffer.alloc(0), final = false): string {
      if (fallback) return gbk.decode(chunk, { stream: !final });
      const bytes = Buffer.concat([pending, chunk]);
      let end = bytes.length;
      if (!final && end) {
        let start = end - 1;
        while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
        const first = bytes[start] ?? 0;
        const length =
          first >= 0xc2 && first <= 0xdf
            ? 2
            : first >= 0xe0 && first <= 0xef
              ? 3
              : first >= 0xf0 && first <= 0xf4
                ? 4
                : 1;
        if (start >= 0 && start + length > end) end = start;
      }
      try {
        const text = utf8.decode(bytes.subarray(0, end), { stream: !final });
        pending = Buffer.from(bytes.subarray(end));
        return text;
      } catch {
        fallback = true;
        pending = Buffer.alloc(0);
        return gbk.decode(bytes, { stream: !final });
      }
    },
  };
}

/** Split by encoded bytes without splitting a Unicode code point. */
export function takeUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString(), bytes: end };
}
