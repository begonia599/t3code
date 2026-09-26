import { describe, expect, it } from "vite-plus/test";
import { translate } from "./i18n";

describe("interface translations", () => {
  it("switches known interface copy and keeps unknown project data intact", () => {
    expect(translate("en", "Settings")).toBe("Settings");
    expect(translate("zh-CN", "Settings")).toBe("设置");
    expect(translate("zh-CN", "my-project-123")).toBe("my-project-123");
  });
});
