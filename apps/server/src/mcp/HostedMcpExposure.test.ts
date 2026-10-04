import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type HostedMcpConfig,
} from "@t3tools/contracts";
import { adaptResult, removeArtifact, validateFiles } from "./HostedMcpExposure.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

it("adapts NAI results and accepts only shared image files and known artifact ids", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-nai-exposure-"));
  const config: HostedMcpConfig = {
    id: "nai",
    label: "NAI",
    enabled: true,
    allowedInstances: [ProviderInstanceId.make("claudeAgent")],
    adapter: { kind: "nai", artifactDirectory: root },
    transport: { type: "stdio", command: "/usr/bin/true", args: [], environment: {} },
  };
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("exposure-test"),
    threadId: ThreadId.make("exposure-thread"),
    providerSessionId: "exposure-session",
    providerInstanceId: config.allowedInstances[0]!,
    allowedFileRoots: [root],
    capabilities: new Set(),
    issuedAt: 1,
  };
  try {
    const data = {
      http_api: { url: "http://10.0.0.8:8787" },
      default_model: "fixture",
      image_models: ["host-only"],
    };
    const result = adaptResult(config, "nai_capabilities", {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    });
    expect(result.structuredContent).toEqual({ default_model: "fixture" });
    expect(result.content).toEqual([{ type: "text", text: '{"default_model":"fixture"}' }]);
    const text = NodePath.join(root, "credential.txt");
    await NodeFSP.writeFile(text, "a credential is not an image");
    await expect(
      validateFiles(config, scope, "nai_upscale_image", { image_path: text }),
    ).rejects.toThrow("PNG or WebP");
    const link = NodePath.join(root, "escaped.png");
    await NodeFSP.symlink("/etc/passwd", link);
    await expect(
      validateFiles(config, scope, "nai_upscale_image", { image_path: link }),
    ).rejects.toThrow("outside");
    const id = "abcdef0123456789abcdef0123456789";
    const image = NodePath.join(root, `${id}.png`);
    await NodeFSP.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await validateFiles(config, scope, "nai_upscale_image", { image_path: image });
    await expect(removeArtifact(config, scope, { artifact_id: "../credential" })).rejects.toThrow(
      "artifact id",
    );
    expect(
      (await removeArtifact(config, scope, { artifact_id: id })).structuredContent?.removed,
    ).toBe(1);
    expect(await NodeFSP.readFile(text, "utf8")).toBe("a credential is not an image");
    expect(
      (await removeArtifact(config, scope, { artifact_id: id })).structuredContent?.removed,
    ).toBe(0);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
