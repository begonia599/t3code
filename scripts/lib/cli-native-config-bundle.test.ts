// @effect-diagnostics nodeBuiltinImport:off - Exercise the packaged code in an isolated Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

import serverConfig from "../../apps/server/vite.config.ts";

it("bundles native configuration editing without runtime parser dependencies", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-config-bundle-"));
  try {
    const pack = serverConfig.pack;
    if (!pack || Array.isArray(pack)) throw new Error("Expected a single server pack config.");
    await build({
      ...pack,
      config: false,
      entry: {
        config: NodeURL.fileURLToPath(
          new URL("../../packages/shared/src/nativeConfig.ts", import.meta.url),
        ),
      },
      outDir: directory,
      exe: false,
      dts: false,
      sourcemap: false,
    });
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        String.raw`import { editNativeConfigField, nativeConfigFields, parseNativeConfig } from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(directory, "config.mjs")).href)};
const content = '{\n  // keep this comment\n  "env": {"BASH_DEFAULT_TIMEOUT_MS": "120000"}\n}\n';
const edited = editNativeConfigField(content, "json", nativeConfigFields.json[0], "180000");
console.log(JSON.stringify({
  value: parseNativeConfig(edited, "json").env.BASH_DEFAULT_TIMEOUT_MS,
  commentPreserved: edited.includes("// keep this comment"),
  tomlValue: parseNativeConfig('model_verbosity = "medium"', "toml").model_verbosity,
}));`,
      ],
      { cwd: directory, encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual({
      value: "180000",
      commentPreserved: true,
      tomlValue: "medium",
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
