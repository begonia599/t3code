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
  let cursor = 0;

  while (cursor < text.length) {
    let matchIndex = text.length;
    let matchLength = 0;
    for (const term of terms) {
      const index = normalizedText.indexOf(term, cursor);
      if (
        index !== -1 &&
        (index < matchIndex || (index === matchIndex && term.length > matchLength))
      ) {
        matchIndex = index;
        matchLength = term.length;
      }
    }
    if (matchLength === 0) {
      parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
      break;
    }
    if (matchIndex > cursor) {
      parts.push({ text: text.slice(cursor, matchIndex), highlighted: false, start: cursor });
    }
    parts.push({
      text: text.slice(matchIndex, matchIndex + matchLength),
      highlighted: true,
      start: matchIndex,
    });
    cursor = matchIndex + matchLength;
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
