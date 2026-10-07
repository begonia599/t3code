export function threadSearchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(Boolean))];
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function splitThreadSearchHighlightParts(text: string, query: string) {
  const terms = threadSearchTerms(query).map(foldAsciiCase);
  const normalizedText = foldAsciiCase(text);
  const parts: Array<{
    readonly text: string;
    readonly highlighted: boolean;
    readonly start: number;
  }> = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    let start = normalizedText.indexOf(term);
    while (start !== -1) {
      ranges.push({ start, end: start + term.length });
      start = normalizedText.indexOf(term, start + 1);
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
    }
    parts.push({ text: text.slice(range.start, range.end), highlighted: true, start: range.start });
    cursor = range.end;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }

  return parts;
}

export function firstThreadSearchTermIndex(text: string, query: string): number {
  const normalizedText = foldAsciiCase(text);
  const indexes = threadSearchTerms(query)
    .map((term) => normalizedText.indexOf(foldAsciiCase(term)))
    .filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}
