import { expect, it } from "vite-plus/test";

import {
  firstThreadSearchTermIndex,
  splitThreadSearchHighlightParts,
  threadSearchTerms,
} from "./threadSearch.ts";

it("splits search terms and highlights separated matches in their text order", () => {
  expect(threadSearchTerms("  skill  缓存  ")).toEqual(["skill", "缓存"]);
  expect(splitThreadSearchHighlightParts("缓存了新的 Skill 定义", "skill 缓存")).toEqual([
    { text: "缓存", highlighted: true, start: 0 },
    { text: "了新的 ", highlighted: false, start: 2 },
    { text: "Skill", highlighted: true, start: 6 },
    { text: " 定义", highlighted: false, start: 11 },
  ]);
  expect(firstThreadSearchTermIndex("缓存了新的 Skill 定义", "skill 缓存")).toBe(0);
});
