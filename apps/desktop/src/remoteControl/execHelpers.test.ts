import { describe, expect, it } from "vite-plus/test";
import {
  cmdCommandLine,
  commandSummary,
  createOutputDecoder,
  escapeCmdArgument,
  escapeCmdCommand,
  takeUtf8,
  windowsExecutableCandidates,
} from "./execHelpers.ts";

describe("Windows executable resolution", () => {
  it("searches cwd then PATH in PATHEXT order, with case-insensitive environment names", () => {
    expect(
      windowsExecutableCandidates("tool", "C:\\work", {
        Path: '"D:\\bin";E:\\bin',
        PathExt: ".EXE;.CMD",
      }),
    ).toEqual([
      "C:\\work\\tool.EXE",
      "C:\\work\\tool.CMD",
      "D:\\bin\\tool.EXE",
      "D:\\bin\\tool.CMD",
      "E:\\bin\\tool.EXE",
      "E:\\bin\\tool.CMD",
    ]);
    expect(
      windowsExecutableCandidates("tool.cmd", "C:\\work", {
        PATH: "D:\\bin",
        PATHEXT: ".EXE;.CMD",
      }),
    ).toEqual(["C:\\work\\tool.cmd", "D:\\bin\\tool.cmd"]);
    expect(
      windowsExecutableCandidates(".\\tool", "C:\\work", { PATH: "D:\\bin", PATHEXT: ".EXE" }),
    ).toEqual(["C:\\work\\tool.EXE"]);
  });
});
describe("cmd escaping", () => {
  it.each([
    ["", '^"^"'],
    ["a b", '^"a^ b^"'],
    ['a"b', '^"a\\^"b^"'],
    ["^&|<>%!", '^"^^^&^|^<^>^%^!^"'],
    ["a\\", '^"a\\\\^"'],
    ['a\\"b', '^"a\\\\\\^"b^"'],
    ["a\\b", '^"a\\b^"'],
  ])("quotes %j", (input, expected) => expect(escapeCmdArgument(input)).toBe(expected));
  it("escapes commands and double-escapes npm cmd shims", () => {
    expect(escapeCmdCommand("C:\\Program Files\\a&b.cmd")).toBe("C:\\Program^ Files\\a^&b.cmd");
    expect(cmdCommandLine("C:\\a.cmd", ["x y"])).toBe('"C:\\a.cmd ^"x^ y^""');
    expect(escapeCmdArgument("x&y", true)).toBe('^^^"x^^^&y^^^"');
    expect(cmdCommandLine("C:\\node_modules\\.bin\\a.cmd", ["x&y"])).toContain('^^^"x^^^&y^^^"');
  });
});
describe("stream decoding", () => {
  it("preserves split UTF-8 code points at every boundary", () => {
    const bytes = Buffer.from("汉字🙂hello");
    for (let i = 1; i < bytes.length; i++) {
      const decoder = createOutputDecoder();
      expect(
        decoder.decode(bytes.subarray(0, i)) +
          decoder.decode(bytes.subarray(i)) +
          decoder.decode(undefined, true),
      ).toBe("汉字🙂hello");
      expect(decoder.decodedAsGbk).toBe(false);
    }
  });
  it("replays invalid chunks and buffered bytes as GBK and remains in GBK", () => {
    const decoder = createOutputDecoder();
    expect(decoder.decode(Buffer.from([0xd6]))).toBe("");
    expect(decoder.decode(Buffer.from([0xd0, 0xce, 0xc4])) + decoder.decode(undefined, true)).toBe(
      "中文",
    );
    expect(decoder.decodedAsGbk).toBe(true);
    expect(decoder.decode(Buffer.from([0xd6, 0xd0]))).toBe("中");
    const final = createOutputDecoder();
    expect(final.decode(Buffer.from([0xe4])) + final.decode(undefined, true)).toBe("�");
  });
  it("splits output on byte boundaries without breaking Unicode", () => {
    expect(takeUtf8("汉🙂x", 6)).toEqual({ text: "汉", bytes: 3 });
    expect(takeUtf8("🙂", 3)).toEqual({ text: "", bytes: 0 });
  });
});
it("uses exactly the gateway summary algorithm and cap", () => {
  const common = { serverCwd: "/", env: {}, timeoutMs: 1000, noSync: false };
  expect(
    commandSummary({ ...common, mode: "argv", argv: ["node", "", "a b", 'a"b', "a\\b"] }),
  ).toBe('node "" "a b" "a\\"b" a\\b');
  expect(commandSummary({ ...common, mode: "powershell", script: "x".repeat(600) })).toBe(
    "x".repeat(500),
  );
});

it("preserves a BOM appearing after the beginning of a UTF-8 stream", () => {
  const decoder = createOutputDecoder();
  expect(
    decoder.decode(Buffer.from("one")) +
      decoder.decode(Buffer.from("\uFEFFtwo")) +
      decoder.decode(undefined, true),
  ).toBe("one\uFEFFtwo");
});

it("escapes every cross-spawn cmd metacharacter and long backslash runs", () => {
  expect(escapeCmdCommand('[]`()%!^"<>&|;, *?')).toBe('^[^]^`^(^)^%^!^^^"^<^>^&^|^;^,^ ^*^?');
  expect(escapeCmdArgument("\\".repeat(10000))).toHaveLength(20004);
});
