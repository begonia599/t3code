import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AntigravityAuthMethod,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  makeAntigravityStderrHandler,
  makeAntigravityStdoutTransform,
} from "../antigravityAuthSupport.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { normalizeAntigravitySessionUpdate } from "./AntigravityProtocol.ts";

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "cancelBehavior"
  | "clientCapabilities"
  | "normalizeConfigOptions"
  | "onStderr"
  | "resumeMethod"
  | "transformSessionUpdate"
  | "transformStdout"
> {
  /** Device CLI environment supplied for this provider session. */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Abort unattended setup if agy requests a browser, including a local enterprise license picker. */
  readonly rejectBrowserLaunches?: boolean;
  readonly onAuthorizationUrl?: (url: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * Advertise `fs.readTextFile` and `fs.writeTextFile`. The agent then routes
   * workspace reads and writes through T3, which turns each edit into a
   * `session/request_permission` with the file content, instead of writing
   * through its own tools. Chat sessions turn this on. Setup, probe, and text
   * generation helpers leave it off so they never touch a workspace.
   */
  readonly clientFileSystem?: boolean;
  /** ACP `authenticate` method id. Defaults to the personal Google account flow. */
  readonly authMethod?: AntigravityAuthMethod;
}

/** Normal launches reject browser login; only the auth flow supplies `onAuthorizationUrl`. */
export const makeAntigravityAcpRuntime = Effect.fn("makeAntigravityAcpRuntime")(function* (
  input: AntigravityAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: input.authMethod ?? "oauth-personal",
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: {
          readTextFile: input.clientFileSystem === true,
          writeTextFile: input.clientFileSystem === true,
        },
        terminal: false,
      },
      transformStdout: makeAntigravityStdoutTransform(
        input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {},
      ),
      onStderr: makeAntigravityStderrHandler({
        ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        rejectBrowserLaunches: input.rejectBrowserLaunches === true,
      }),
      normalizeConfigOptions: makeAntigravityModelPicker(input.authMethod ?? "oauth-personal"),
      transformSessionUpdate: normalizeAntigravitySessionUpdate,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

// agy exposes these older OAuth IDs under family/level pairs that their suffixes do not encode.
const legacyOAuthVariants = new Map([
  ["gemini-3.5-flash-extra-low", ["gemini-3.5-flash", "low"]],
  ["gemini-3.5-flash-low", ["gemini-3.5-flash", "medium"]],
  ["gemini-3-flash-agent", ["gemini-3.5-flash", "high"]],
  ["gemini-pro-agent", ["gemini-3.1-pro", "high"]],
]);

/** Keep concrete IDs selectable when agy 1.5 groups them in its config picker.
 * Session setup supplies the native flat catalog. Later config replies only carry family and level.
 */
export function makeAntigravityModelPicker(authMethod: AntigravityAuthMethod) {
  const variants = new Map<string, Array<{ value: string; name: string; level: string }>>();
  return (
    config: readonly EffectAcpSchema.SessionConfigOption[],
    models?: EffectAcpSchema.SessionModelState | null,
  ) => {
    if (models) {
      variants.clear();
      const oauth = authMethod === "oauth-personal" || authMethod === "oauth-business";
      for (const { modelId, name } of models.availableModels) {
        const legacy = oauth ? legacyOAuthVariants.get(modelId) : undefined;
        const match = /^(.+)-(minimal|low|medium|high|xhigh|extra_high|max)(?:-effort)?$/.exec(
          modelId,
        );
        const family = legacy?.[0] ?? match?.[1];
        const level = legacy?.[1] ?? match?.[2];
        if (!family || !level) continue;
        const entries = variants.get(family) ?? [];
        entries.push({ value: modelId, name, level });
        variants.set(family, entries);
      }
      // An offered concrete ID wins any collision with a family, just as it does in agy.
      for (const { modelId } of models.availableModels) variants.delete(modelId);
    }
    const model = config.find((option) => option.id === "model");
    if (
      model?.type !== "select" ||
      !model.options.some((entry) => "value" in entry && variants.has(entry.value))
    )
      return config;
    const thinking = config.find((option) => option.id === "thinking_level");
    // The thinking selector describes only the currently selected family.
    const levels =
      thinking?.type === "select"
        ? new Set(
            thinking.options.flatMap((entry) =>
              "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
            ),
          )
        : undefined;
    const currentVariants = variants
      .get(model.currentValue)
      ?.filter((variant) => !levels || levels.has(variant.level));
    const selected =
      thinking?.type === "select"
        ? currentVariants?.find((v) => v.level === thinking.currentValue)?.value
        : undefined;
    return config.map((option) =>
      option === model
        ? {
            ...model,
            currentValue: models?.currentModelId ?? selected ?? model.currentValue,
            options: model.options.flatMap((entry) => {
              if (!("value" in entry)) return entry.options;
              const available =
                entry.value === model.currentValue ? currentVariants : variants.get(entry.value);
              return available ?? [entry];
            }),
          }
        : option,
    );
  };
}

export function antigravityPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "auto_edit";
    case "auto":
    case "approval-required":
      return "default";
  }
}

export function antigravityModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/**
 * Resolves the model a turn should run on. A saved selection is reapplied
 * as-is. The provider default alias resolves to `defaultModel` when the
 * account offers it, so T3 can pick a newer model than the one Google marks
 * current. Otherwise the agent's current selection stands.
 */
export function resolveAntigravityModel(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly model: string | null | undefined;
  readonly defaultModel?: string | undefined;
}): string | undefined {
  const modelConfig = input.configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  if (input.model && input.model !== ANTIGRAVITY_DEFAULT_MODEL) return input.model;
  const options = antigravityModelOptions(input.configOptions);
  return input.defaultModel && options.some((option) => option.value === input.defaultModel)
    ? input.defaultModel
    : current;
}

/** Never replace a saved selection with the default returned by a cold resume. */
export const applyAntigravityAcpModelSelection = Effect.fn("applyAntigravityAcpModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel"
    >;
    readonly model: string | null | undefined;
    /** Model to select for the provider default alias. See `resolveAntigravityModel`. */
    readonly defaultModel?: string | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelConfig = configOptions.find((option) => option.id === "model");
    const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
    const resolved = resolveAntigravityModel({
      configOptions,
      model: input.model,
      defaultModel: input.defaultModel,
    });
    // The default alias never sends an internal ID. It selects the manifest
    // default when that differs from the agent's current model, and otherwise
    // leaves the agent's choice alone.
    const explicit = Boolean(input.model) && input.model !== ANTIGRAVITY_DEFAULT_MODEL;
    if (resolved === undefined || (!explicit && resolved === current)) return current;
    const options = antigravityModelOptions(configOptions);
    if (!options.some((option) => option.value === resolved)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Antigravity model '${resolved}' is unavailable for this Google account. Select an available model.`,
          ),
        ),
      );
    }
    yield* input.runtime.setModel(resolved).pipe(Effect.mapError(input.mapError));
    return resolved;
  },
);

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
// Formats the bundled SDK's Audio type accepts. Anything else is rejected up front.
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);
const ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".svelte",
  ".vue",
  ".log",
  ".diff",
  ".patch",
  ".ini",
  ".conf",
]);
const ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

/**
 * Sends supported uploads as native ACP content. Other files, and native
 * candidates over their limits, reach the agent through the saved path
 * ProviderService puts in the text block.
 */
export const buildAntigravityPrompt = Effect.fn("buildAntigravityPrompt")(function* (input: {
  readonly input: ProviderSendTurnInput["input"];
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly attachmentsDir: string;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  const text = input.input?.trim();
  if (text) blocks.push({ type: "text", text });
  let totalBytes = 0;

  for (const attachment of input.attachments ?? []) {
    const isPastedText =
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text";
    // ProviderService has already put the file path in the text block. Keep a
    // folded clipboard paste lazy so the agent can search or sample it rather
    // than paying to embed the entire resource in context immediately.
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const audio = attachment.type === "file" && AUDIO_MIME_TYPES.has(mimeType);
    const pdf = attachment.type === "file" && mimeType === "application/pdf";
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") ||
        TEXT_MIME_TYPES.has(mimeType) ||
        TEXT_FILE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()));
    const isPathOnly =
      attachment.type === "file" && (isPastedText || (!audio && !pdf && !textFile));
    if (attachment.type === "image" && !image) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Antigravity does not support '${attachment.name}' (${attachment.mimeType}). Attach a BMP, JPEG, PNG, WebP, PDF, audio, or text file.`,
      );
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Invalid attachment '${attachment.name}'.`,
      );
    }
    const info = yield* fileSystem
      .stat(attachmentPath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Could not read attachment '${attachment.name}'.`,
          ),
        ),
      );
    if (info.type !== "File") {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Could not read attachment '${attachment.name}'.`,
      );
    }
    if (isPathOnly) continue;
    const size = Number(info.size);
    const limit = image
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : audio
        ? ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES
        : pdf
          ? MAX_TOTAL_ATTACHMENT_BYTES
          : ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES;
    if (
      attachment.type === "file" &&
      (size > limit || totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES)
    ) {
      continue;
    }
    totalBytes += size;
    if (size > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Image '${attachment.name}' is too large. Antigravity accepts images up to 10 MiB and 50 MiB of native attachments per message.`,
      );
    }
    const uri = yield* path.toFileUrl(attachmentPath).pipe(
      Effect.map((url) => url.href),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(`Invalid attachment '${attachment.name}'.`),
      ),
    );
    if (pdf) {
      blocks.push({ type: "resource_link", uri, name: attachment.name, mimeType });
      continue;
    }
    const bytes = yield* fileSystem.stream(attachmentPath, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.map((chunks) => Buffer.concat(chunks)),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Could not read attachment '${attachment.name}'.`,
        ),
      ),
    );
    totalBytes += bytes.length - size;
    if (bytes.length > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' changed while being read and is too large.`,
      );
    }
    if (image) {
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else if (audio) {
      blocks.push({ type: "audio", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else {
      const decoded = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Attachment '${attachment.name}' is not a UTF-8 text file.`,
          ),
      });
      if (decoded.includes("\0")) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          `Attachment '${attachment.name}' contains binary data.`,
        );
      }
      blocks.push({ type: "resource", resource: { uri, mimeType, text: decoded } });
    }
  }
  if (blocks.length === 0) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "A turn requires text or supported attachments.",
    );
  }
  return blocks;
});
