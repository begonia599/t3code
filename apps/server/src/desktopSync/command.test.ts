import { describe, expect, it } from "vite-plus/test";
import { parseCommand } from "./command.ts";

const base = ".mutagen/agents/0.18.1/mutagen-agent synchronizer";
describe("parseCommand", () => {
  it.each([undefined, "disabled", "error", "warn", "info", "debug", "trace"])(
    "accepts the exact synchronizer invocation (%s)",
    (level) => {
      expect(parseCommand(base + (level ? ` --log-level=${level}` : ""))).toEqual({
        ok: true,
        args: ["synchronizer", ...(level ? [`--log-level=${level}`] : [])],
      });
    },
  );
  it("distinguishes a well-formed incompatible version", () => {
    expect(parseCommand(base.replace("0.18.1", "0.18.0"))).toEqual({
      ok: false,
      code: "VERSION_MISMATCH",
    });
  });
  it.each([
    "",
    ` ${base}`,
    `${base} `,
    `${base}\n`,
    `${base}\r\n`,
    `${base}\0`,
    base.replace(" synchronizer", "  synchronizer"),
    base.replace(" synchronizer", "\tsynchronizer"),
    base.replace("synchronizer", "forwarder"),
    base.replace("synchronizer", "install"),
    base.replace("0.18.1", "../0.18.1"),
    base.replace("0.18.1", "0.18.1/.."),
    base.replace("0.18.1", "0.18.1-beta"),
    `/${base}`,
    `./${base}`,
    `~/${base}`,
    `${base}; id`,
    `${base} && id`,
    `${base} | cat`,
    `${base} > /tmp/foo`,
    `${base} $(id)`,
    `${base} \`id\``,
    `${base} --log-level=warning`,
    `${base} --log-level=INFO`,
    `${base} --log-level info`,
    `${base} --log-level=`,
    `${base} --help`,
    `${base} --log-level=info --log-level=debug`,
    `${base} --log-level=info --help`,
    base.replaceAll("/", "\\"),
    `"${base}"`,
    base.replace("0.18.1", "0.18.0") + "; id",
  ])("rejects %j", (command) => {
    expect(parseCommand(command)).toEqual({ ok: false, code: "COMMAND_REJECTED" });
  });
});
