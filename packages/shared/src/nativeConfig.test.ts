import { describe, expect, it } from "vite-plus/test";
import { editNativeConfigField, nativeConfigFields, parseNativeConfig } from "./nativeConfig.ts";

describe("native config field editing", () => {
  const verbosity = nativeConfigFields.toml[0]!;
  it("preserves TOML comments, unknown fields and nested keys", () => {
    const source =
      '# personal\r\nmodel_verbosity = "low" # detail\r\nunknown = [1, 2]\r\n[other]\r\nmodel_verbosity = "medium"\r\n';
    const next = editNativeConfigField(source, "toml", verbosity, "high");
    expect(next).toBe(source.replace('model_verbosity = "low"', 'model_verbosity = "high"'));
    const reset = editNativeConfigField(next, "toml", verbosity, "");
    expect(reset).toContain("# detail");
    expect(parseNativeConfig(reset, "toml")).toEqual({
      unknown: [1, 2],
      other: { model_verbosity: "medium" },
    });
    expect(editNativeConfigField('model_verbosity="low"#keep\n', "toml", verbosity, "high")).toBe(
      'model_verbosity = "high"#keep\n',
    );
    expect(
      editNativeConfigField('model_verbosity="text#inside"#keep\n', "toml", verbosity, "high"),
    ).toBe('model_verbosity = "high"#keep\n');
  });
  it("does not edit a lookalike assignment inside a multiline string", () => {
    const source = 'unknown = """\nmodel_verbosity = "low"\n"""\nmodel_verbosity = "low"\n';
    const next = editNativeConfigField(source, "toml", verbosity, "high");
    expect(next).toBe('unknown = """\nmodel_verbosity = "low"\n"""\nmodel_verbosity = "high"\n');
  });
  it("adds top-level fields before existing tables and removes overrides", () => {
    const source = "[unknown]\nvalue = true\n";
    const next = editNativeConfigField(source, "toml", verbosity, "medium");
    expect(parseNativeConfig(next, "toml")).toEqual({
      model_verbosity: "medium",
      unknown: { value: true },
    });
    expect(editNativeConfigField(source, "toml", verbosity, "")).toBe(source);
  });
  it("requires raw editing for non-simple TOML assignments", () => {
    expect(() =>
      editNativeConfigField('"model_verbosity" = "low"\n', "toml", verbosity, "high"),
    ).toThrow("raw editor");
  });
  it("retains JSON unknown data and writes native env values as strings", () => {
    const field = nativeConfigFields.json[0]!;
    const source = '{\n  "unknown": {"keep": true},\n  "env": {"OTHER": "keep"}\n}\n';
    const next = editNativeConfigField(source, "json", field, "30000");
    expect(JSON.parse(next)).toEqual({
      unknown: { keep: true },
      env: { OTHER: "keep", BASH_DEFAULT_TIMEOUT_MS: "30000" },
    });
    expect(JSON.parse(editNativeConfigField(next, "json", field, ""))).toEqual(JSON.parse(source));
  });
  it("preserves native JSON comments, trailing commas and the byte-order marker", () => {
    const source = '\uFEFF{\n  // user note\n  "unknown": true,\n}\n';
    const next = editNativeConfigField(source, "json", nativeConfigFields.json[0]!, "30000");
    expect(next.startsWith("\uFEFF")).toBe(true);
    expect(next).toContain("// user note");
    expect(parseNativeConfig(next, "json")).toEqual({
      unknown: true,
      env: { BASH_DEFAULT_TIMEOUT_MS: "30000" },
    });
  });
  it("retains unrelated TOML 64-bit integers without rounding them", () => {
    const source = "unknown = 9223372036854775807\n";
    const next = editNativeConfigField(source, "toml", verbosity, "high");
    expect(next).toContain(source);
    expect(parseNativeConfig(next, "toml").unknown).toBe(9223372036854775807n);
  });
  it("rejects invalid values without changing the source", () => {
    for (const value of ["0", "1.5", "-1", "999999999999999999999", "junk"]) {
      expect(() =>
        editNativeConfigField("{}", "json", nativeConfigFields.json[0]!, value),
      ).toThrow();
    }
    expect(() => editNativeConfigField("", "toml", verbosity, "unexpected")).toThrow();
    expect(() => parseNativeConfig("[]", "json")).toThrow();
    expect(() =>
      editNativeConfigField(
        '{"env":{"BASH_DEFAULT_TIMEOUT_MS":"1"},"env":{"BASH_DEFAULT_TIMEOUT_MS":"2"}}',
        "json",
        nativeConfigFields.json[0]!,
        "30000",
      ),
    ).toThrow("raw editor");
  });
});
