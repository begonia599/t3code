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

it("deduplicates terms separated by different whitespace", () => {
  expect(threadSearchTerms(" skill\t缓存\n skill\u3000缓存 ")).toEqual(["skill", "缓存"]);
  expect(threadSearchTerms(" \n\t ")).toEqual([]);
});

it("merges overlapping and repeated occurrences without losing characters", () => {
  expect(splitThreadSearchHighlightParts("x ababa!", "aba bab")).toEqual([
    { text: "x ", highlighted: false, start: 0 },
    { text: "ababa", highlighted: true, start: 2 },
    { text: "!", highlighted: false, start: 7 },
  ]);
});

it("treats punctuation literally and preserves offsets after emoji", () => {
  expect(splitThreadSearchHighlightParts("😀 100% [a] _ !", "[a] 100% _ !")).toEqual([
    { text: "😀 ", highlighted: false, start: 0 },
    { text: "100%", highlighted: true, start: 3 },
    { text: " ", highlighted: false, start: 7 },
    { text: "[a]", highlighted: true, start: 8 },
    { text: " ", highlighted: false, start: 11 },
    { text: "_", highlighted: true, start: 12 },
    { text: " ", highlighted: false, start: 13 },
    { text: "!", highlighted: true, start: 14 },
  ]);
  expect(firstThreadSearchTermIndex("😀 100% [a]", "[a] 100%")).toBe(3);
});

it("leaves missing and empty searches unchanged", () => {
  for (const query of ["absent", " \t ", "É"]) {
    expect(splitThreadSearchHighlightParts("é text", query)).toEqual([
      { text: "é text", highlighted: false, start: 0 },
    ]);
    expect(firstThreadSearchTermIndex("é text", query)).toBe(-1);
  }
  expect(splitThreadSearchHighlightParts("", "text")).toEqual([]);
});
