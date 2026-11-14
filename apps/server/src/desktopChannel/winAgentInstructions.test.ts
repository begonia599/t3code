import { describe, expect, it } from "vite-plus/test";
import { buildWindowsProjectInstructions } from "./winAgentInstructions.ts";

describe("Windows project instructions", () => {
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
