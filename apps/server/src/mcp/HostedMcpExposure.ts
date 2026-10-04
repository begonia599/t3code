// @effect-diagnostics nodeBuiltinImport:off - Native MCP file arguments refer to host-owned shared mounts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { HostedMcpConfig, HostedMcpExposure } from "@t3tools/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const nai: HostedMcpExposure = {
  instructions:
    "Use these MCP tools for NovelAI operations. For scripts, request access with t3-code.mcp_request_script_access, then use its t3-resource command. Returned artifact paths are shared files; the output directory is read-only in the sandbox. If listed, use nai_delete_artifact with an artifact id to remove a generated file.",
  allowedTools: [
    "nai_capabilities",
    "nai_list_models",
    "nai_generate_image",
    "nai_suggest_tags",
    "nai_upscale_image",
    "nai_augment_image",
    "nai_encode_vibe",
    "nai_delete_artifact",
  ],
  toolDescriptions: {
    nai_capabilities:
      "Describe NovelAI operations, parameters and default model. Use nai_list_models for model ids. This does not expose a separate HTTP API for scripts.",
    nai_list_models:
      "List supported NovelAI image model ids from the public catalogue. This catalogue does not verify the current account's entitlements.",
    nai_generate_image:
      "Generate images through the hosted NovelAI service. Return artifact ids and shared absolute file paths. The NovelAI credential stays in T3.",
    nai_upscale_image:
      "Upscale a PNG or WebP from an absolute shared path visible to this instance. T3 checks the path; the hosted service reads the file.",
    nai_augment_image:
      "Apply NovelAI Director Tools to a PNG or WebP from an absolute shared path visible to this instance.",
    nai_encode_vibe:
      "Encode a PNG or WebP at an absolute shared path into a vibe artifact. Return its id and shared file path.",
  },
  parameterDescriptions: {
    nai_generate_image: {
      human_request_id:
        "A nonempty correlation id for the user's task; reuse it within one batch. It is a label, not proof of approval.",
      model: "An API id from nai_list_models; leave empty to use the configured default.",
    },
    nai_upscale_image: {
      image_path: "Absolute path to a PNG or WebP in a file root allowed to this instance.",
      human_request_id: "A nonempty correlation id for the user's task, not proof of approval.",
    },
    nai_augment_image: {
      image_path: "Absolute path to a PNG or WebP in a file root allowed to this instance.",
      human_request_id: "A nonempty correlation id for the user's task, not proof of approval.",
    },
    nai_encode_vibe: {
      image_path: "Absolute path to a PNG or WebP in a file root allowed to this instance.",
      mask_path: "Optional absolute PNG or WebP path in an allowed file root.",
    },
  },
  omittedResultProperties: {
    nai_capabilities: ["http_api", "image_models", "account_verified"],
    nai_list_models: ["account_verified"],
    nai_generate_image: ["download_path"],
    nai_upscale_image: ["download_path"],
    nai_augment_image: ["download_path"],
    nai_encode_vibe: ["download_path"],
  },
  fileInputs: {
    nai_upscale_image: ["image_path"],
    nai_augment_image: ["image_path"],
    nai_encode_vibe: ["image_path", "mask_path"],
  },
};

export const exposureFor = (config: HostedMcpConfig): HostedMcpExposure => {
  const defaults = config.adapter?.kind === "nai" ? nai : {};
  const custom = config.exposure;
  return {
    ...defaults,
    ...custom,
    toolDescriptions: { ...defaults.toolDescriptions, ...custom?.toolDescriptions },
    parameterDescriptions: { ...defaults.parameterDescriptions, ...custom?.parameterDescriptions },
    omittedResultProperties: {
      ...defaults.omittedResultProperties,
      ...custom?.omittedResultProperties,
    },
    fileInputs: { ...defaults.fileInputs, ...custom?.fileInputs },
  };
};
export const toolAllowed = (config: HostedMcpConfig, scope: McpInvocationScope, name: string) => {
  const allowed = exposureFor(config).allowedTools;
  return (
    (!allowed || allowed.includes(name)) &&
    (!scope.script || (scope.script.serviceId === config.id && scope.script.tools.has(name)))
  );
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Remove only configured property names, keeping structured and textual JSON aligned. */
const omit = (value: unknown, names: ReadonlySet<string>): unknown => {
  if (Array.isArray(value)) return value.map((item) => omit(item, names));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !names.has(name))
      .map(([name, item]) => [name, omit(item, names)]),
  );
};
const omitSchema = (value: unknown, names: ReadonlySet<string>): unknown => {
  if (Array.isArray(value)) return value.map((item) => omitSchema(item, names));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      if (name === "properties" && record(item))
        return [
          name,
          Object.fromEntries(
            Object.entries(item)
              .filter(([key]) => !names.has(key))
              .map(([key, schema]) => [key, omitSchema(schema, names)]),
          ),
        ];
      if (name === "required" && Array.isArray(item))
        return [name, item.filter((key) => typeof key !== "string" || !names.has(key))];
      return [name, omitSchema(item, names)];
    }),
  );
};

export const adaptTool = (config: HostedMcpConfig, tool: Tool): Tool => {
  const exposure = exposureFor(config);
  const descriptions = exposure.parameterDescriptions?.[tool.name];
  const properties = tool.inputSchema.properties;
  const omitted = new Set(exposure.omittedResultProperties?.[tool.name] ?? []);
  return {
    ...tool,
    ...(exposure.toolDescriptions?.[tool.name]
      ? { description: exposure.toolDescriptions[tool.name] }
      : {}),
    inputSchema: {
      ...tool.inputSchema,
      ...(properties && descriptions
        ? {
            properties: Object.fromEntries(
              Object.entries(properties).map(([name, schema]) => [
                name,
                descriptions[name] && record(schema)
                  ? { ...schema, description: descriptions[name] }
                  : schema,
              ]),
            ),
          }
        : {}),
    },
    ...(tool.outputSchema && omitted.size
      ? { outputSchema: omitSchema(tool.outputSchema, omitted) as Tool["outputSchema"] }
      : {}),
  };
};
export const adaptResult = (
  config: HostedMcpConfig,
  name: string,
  result: CallToolResult,
): CallToolResult => {
  const omitted = new Set(exposureFor(config).omittedResultProperties?.[name] ?? []);
  if (!omitted.size) return result;
  return {
    ...result,
    ...(result.structuredContent
      ? { structuredContent: omit(result.structuredContent, omitted) as Record<string, unknown> }
      : {}),
    content: result.content.map((block) => {
      if (block.type !== "text") return block;
      try {
        return { ...block, text: JSON.stringify(omit(JSON.parse(block.text), omitted)) };
      } catch {
        return block;
      }
    }),
  };
};

const inside = (path: string, root: string) => {
  const relative = NodePath.relative(root, path);
  return (
    !NodePath.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`)
  );
};
export const validateFiles = async (
  config: HostedMcpConfig,
  scope: McpInvocationScope,
  name: string,
  args: Record<string, unknown> | undefined,
) => {
  for (const field of exposureFor(config).fileInputs?.[name] ?? []) {
    const value = args?.[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || !NodePath.isAbsolute(value))
      throw new Error(`${field} must be an absolute shared file path.`);
    const path = await NodeFSP.realpath(value).catch(() => {
      throw new Error(`${field} is not an accessible shared file.`);
    });
    if (!scope.allowedFileRoots?.some((root) => inside(path, root)))
      throw new Error(`${field} is outside this instance's shared file roots.`);
    if (!(await NodeFSP.stat(path)).isFile())
      throw new Error(`${field} must be a regular shared file.`);
    if (config.adapter?.kind === "nai") {
      const file = await NodeFSP.open(path, "r");
      try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (
          !(
            bytesRead >= 8 &&
            header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ) &&
          !(
            bytesRead === 12 &&
            header.toString("ascii", 0, 4) === "RIFF" &&
            header.toString("ascii", 8, 12) === "WEBP"
          )
        )
          throw new Error(`${field} must contain a PNG or WebP image.`);
      } finally {
        await file.close();
      }
    }
  }
};

export const artifactTool: Tool = {
  name: "nai_delete_artifact",
  description: "Delete a generated NovelAI artifact using the id from its generation result.",
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: {
        type: "string",
        pattern: "^[a-f0-9]{32}$",
        description: "The artifact id returned by the generation tool.",
      },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true, idempotentHint: true },
};
export const removeArtifact = async (
  config: HostedMcpConfig,
  scope: McpInvocationScope,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> => {
  const id = args?.artifact_id;
  if (!config.adapter || typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    throw new Error("Use the artifact id returned by a generation tool.");
  const root = await NodeFSP.realpath(config.adapter.artifactDirectory);
  if (!scope.allowedFileRoots?.some((allowed) => inside(root, allowed)))
    throw new Error("The artifact directory is not shared with this instance.");
  const files = (await NodeFSP.readdir(root)).filter(
    (file) => file.startsWith(`${id}.`) && /^[a-f0-9]{32}\.[A-Za-z0-9_-]{1,32}$/.test(file),
  );
  let removed = 0;
  for (const file of files) {
    const path = NodePath.join(root, file);
    if (!(await NodeFSP.lstat(path)).isFile()) continue;
    await NodeFSP.unlink(path);
    removed++;
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ artifact_id: id, removed }) }],
    structuredContent: { artifact_id: id, removed },
  };
};
