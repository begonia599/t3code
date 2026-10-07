import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

export interface NativeConfigField {
  readonly path: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

// This first catalog is deliberately limited to native fields verified against
// Codex 0.160.1 / Claude Code 2.1.291. An unset field stays unset; these are not
// replacement defaults. Runtime/model support remains the provider's decision.
export const nativeConfigFields: Readonly<Record<"toml" | "json", readonly NativeConfigField[]>> = {
  toml: [
    {
      path: ["model_verbosity"],
      label: "Response verbosity",
      description: "Response detail for models that support verbosity.",
      options: ["low", "medium", "high"],
    },
    {
      path: ["model_reasoning_summary"],
      label: "Reasoning summary",
      description: "Summary detail for models that support reasoning summaries.",
      options: ["auto", "concise", "detailed", "none"],
    },
    {
      path: ["tool_output_token_limit"],
      label: "Tool output budget",
      description: "Maximum tokens retained from an individual tool result.",
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    },
    {
      path: ["model_auto_compact_token_limit"],
      label: "Automatic compaction threshold",
      description:
        "Token threshold for automatic context compaction. This does not select local or cloud compaction.",
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    },
  ],
  json: [
    {
      path: ["env", "BASH_DEFAULT_TIMEOUT_MS"],
      label: "Default command timeout",
      description: "Default Bash command timeout in milliseconds (native default: 120000).",
      min: 1,
      max: 2147483647,
    },
    {
      path: ["env", "BASH_MAX_TIMEOUT_MS"],
      label: "Maximum command timeout",
      description:
        "Requested Bash timeout ceiling in milliseconds (native default: 600000). The effective ceiling is at least the default timeout.",
      min: 1,
      max: 2147483647,
    },
    {
      path: ["env", "BASH_MAX_OUTPUT_LENGTH"],
      label: "Command output limit",
      description:
        "Bash output character limit (native default: 30000; maximum: 150000). bashOutputMaxChars takes precedence.",
      min: 1,
      max: 150000,
    },
  ],
};

export function parseNativeConfig(
  content: string,
  format: "toml" | "json",
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown =
    format === "toml"
      ? parseToml(content, { integersAsBigInt: "asNeeded" })
      : parseJsonc(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error("Invalid JSON settings.");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must contain an object.");
  }
  return value as Record<string, unknown>;
}

export function nativeConfigValue(
  document: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let value: unknown = document;
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function scalarLineComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote === '"' && character === "\\") index++;
    else if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#") {
      const whitespace = line.slice(0, index).match(/[ \t]*$/)?.[0] ?? "";
      return whitespace + line.slice(index);
    }
  }
  return "";
}

/** Patch just one supported field, retaining formatting and all unrelated data. */
export function editNativeConfigField(
  content: string,
  format: "toml" | "json",
  field: NativeConfigField,
  value: string,
): string {
  if (!nativeConfigFields[format].includes(field)) throw new Error("Unknown configuration field.");
  const document = parseNativeConfig(content, format);
  const unset = value === "";
  let nextValue: string | number | undefined = unset ? undefined : value;
  if (!unset && field.options) {
    if (!field.options.includes(value)) throw new Error("Choose a supported value.");
  } else if (!unset) {
    const number = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(number) ||
      number < (field.min ?? 0) ||
      number > (field.max ?? Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Enter a whole number within the displayed range.");
    }
    nextValue = format === "json" && field.path[0] === "env" ? String(number) : number;
  }
  if (format === "json") {
    const parent =
      field.path.length > 1 ? nativeConfigValue(document, field.path.slice(0, -1)) : undefined;
    if (
      parent !== undefined &&
      (parent === null || typeof parent !== "object" || Array.isArray(parent))
    ) {
      throw new Error(
        "This field has an incompatible parent value. Use the raw editor to repair it.",
      );
    }
    const next = applyEdits(
      content,
      modify(content, [...field.path], nextValue, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: content.includes("\r\n") ? "\r\n" : "\n",
        },
      }),
    );
    if (nativeConfigValue(parseNativeConfig(next, format), field.path) !== nextValue) {
      throw new Error("Duplicate JSON keys require the raw editor. Your draft was kept unchanged.");
    }
    return next;
  }

  const key = field.path[0]!;
  const expected = { ...document };
  if (unset) delete expected[key];
  else expected[key] = nextValue;
  const expectedJson = canonical(expected);
  const valid = (candidate: string) => {
    try {
      return canonical(parseNativeConfig(candidate, "toml")) === expectedJson;
    } catch {
      return false;
    }
  };
  if (!Object.hasOwn(document, key)) {
    if (unset) return content;
    const candidate = `${key} = ${JSON.stringify(nextValue)}${content.includes("\r\n") ? "\r\n" : "\n"}${content}`;
    if (valid(candidate)) return candidate;
  } else {
    // Only simple scalar assignments are edited graphically. Validate the entire
    // resulting document against the intended semantic change before accepting
    // a candidate, so strings, nested tables, or multiline values cannot trick
    // the line matcher into changing a different field.
    const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\r\\n]*`, "gm");
    for (const match of content.matchAll(pattern)) {
      const comment = scalarLineComment(match[0]);
      const replacement = unset
        ? comment.trimStart()
        : `${key} = ${JSON.stringify(nextValue)}${comment}`;
      const candidate =
        content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
      if (valid(candidate)) return candidate;
    }
  }
  throw new Error("This TOML layout requires the raw editor. Your draft was kept unchanged.");
}
