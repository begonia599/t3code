import { describe, expect, it } from "vite-plus/test";
import { WIN_AGENT_INSTRUCTIONS, buildWindowsProjectInstructions } from "./winAgentInstructions.ts";

describe("Windows project instructions", () => {
  it.each([
    WIN_AGENT_INSTRUCTIONS,
    buildWindowsProjectInstructions({ hostName: "PC", winPath: "C:\\work", serverPath: "/work" }),
  ])("prefers bundled Windows search tools and explains the Everything fallback", (text) => {
    expect(text).toContain("`rg` (ripgrep) is on the Windows PATH");
    expect(text).toContain("prefer it for file contents and `rg --files` for file lists");
    expect(text).toContain(
      "avoid `Get-ChildItem -Recurse` / `Select-String` scans of large directories",
    );
    expect(text).toContain("whole-PC filename searches use `es <keyword>`");
    expect(text).toContain("requires Everything to be running");
    expect(text).toContain('On errors such as "Everything IPC not found"');
    expect(text).toContain("fall back to `rg --files <directory> | rg <keyword>`");
    expect(text).toContain("`win -- rg ...`, `win -- es ...` or `win ps '...'` for pipelines");
  });

  it("sanitizes inserted values and limits host names and Windows paths", () => {
    const text = buildWindowsProjectInstructions({
      hostName: `\n"${"h".repeat(70)}\u0000`,
      winPath: `C:\\${"x".repeat(300)}\r\n`,
      serverPath: "/server\n/project\u0000",
    });
    expect(text).toContain(`PC "${"h".repeat(64)}"`);
    expect(text).toContain(`in ${`C:\\${"x".repeat(300)}`.slice(0, 260)},`);
    expect(text).toContain("(/server/project)");
    expect(text).not.toContain("Use it only when the task needs Windows");
    expect(text).toContain("Windows paths (C:\\");
  });
});
