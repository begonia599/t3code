import {
  ProviderGatewayError,
  type ProviderGatewayProbeInput,
  type ProviderGatewayProbeResult,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { gatewayHeaders, gatewayProblem, isGatewayVariable } from "@t3tools/shared/providerGateway";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";

export class ProviderGateway extends Context.Service<
  ProviderGateway,
  {
    readonly probe: (
      input: ProviderGatewayProbeInput,
    ) => Effect.Effect<ProviderGatewayProbeResult, ProviderGatewayError>;
  }
>()("t3/provider/ProviderGateway") {}

const isGatewayError = Schema.is(ProviderGatewayError);
const failure = (detail: string) => new ProviderGatewayError({ detail });
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function resolveGatewaySecrets(
  draft: ProviderInstanceEnvironment,
  saved: ProviderInstanceEnvironment,
): ProviderInstanceEnvironment {
  const previous = new Map(saved.map((row) => [row.name, row]));
  return draft
    .filter((row) => isGatewayVariable(row.name))
    .map((row) => {
      if (!row.valueRedacted) return row;
      const stored = previous.get(row.name);
      if (!stored?.sensitive || !stored.value)
        throw failure("A saved gateway credential is unavailable. Enter it again.");
      return { ...row, value: stored.value, valueRedacted: false };
    });
}

function httpFailure(status: number): string {
  const hint =
    status === 401 || status === 403
      ? "Check the API key and gateway permissions."
      : status === 404
        ? "Check the base URL and native protocol path."
        : status === 429
          ? "The gateway rate limit or credit limit was reached."
          : "The gateway rejected the request.";
  return `HTTP ${status}. ${hint}`;
}

async function readBounded(response: Response, limit = 512 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw failure("The gateway returned an empty response.");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw failure("The gateway response exceeded the test size limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Interpret native SSE, including terminal events and split UTF-8/network chunks. */
export function inspectGatewayStream(
  text: string,
  protocol: "anthropic" | "responses",
  tool: boolean,
): string | null {
  let ended = false;
  let content = false;
  let toolId: string | undefined;
  let argumentsText = "";
  let validTool = false;
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(data));
    } catch {
      return "The gateway returned malformed SSE data.";
    }
    if (!event) return "The gateway returned an invalid streaming event.";
    const type = event.type;
    if (["error", "response.failed", "response.incomplete"].includes(String(type)))
      return "The gateway stream reported an error or an incomplete response.";
    if (protocol === "anthropic") {
      const block = record(event.content_block);
      const delta = record(event.delta);
      if (
        type === "content_block_start" &&
        block?.type === "tool_use" &&
        block.name === "gateway_probe"
      ) {
        toolId = String(event.index);
        argumentsText = "";
      }
      if (
        type === "content_block_delta" &&
        delta?.type === "input_json_delta" &&
        toolId === String(event.index)
      )
        argumentsText += typeof delta.partial_json === "string" ? delta.partial_json : "";
      if (type === "content_block_stop" && toolId === String(event.index)) {
        try {
          validTool = record(JSON.parse(argumentsText))?.ok === true;
        } catch {
          /* Incomplete arguments are not success. */
        }
      }
      if (
        type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string" &&
        delta.text.trim()
      )
        content = true;
      if (type === "message_stop") ended = true;
    } else {
      if (
        type === "response.output_text.delta" &&
        typeof event.delta === "string" &&
        event.delta.trim()
      )
        content = true;
      if (type === "response.output_item.done") {
        const item = record(event.item);
        if (
          item?.type === "function_call" &&
          item.name === "gateway_probe" &&
          typeof item.arguments === "string"
        ) {
          try {
            validTool = record(JSON.parse(item.arguments))?.ok === true;
          } catch {
            /* Invalid arguments are not success. */
          }
        }
      }
      if (type === "response.completed") ended = true;
    }
  }
  if (!ended) return "The native stream ended without its completion event.";
  if (tool && !validTool)
    return "The gateway did not return the requested tool call with valid arguments.";
  if (!tool && !content) return "The gateway stream contained no text output.";
  return null;
}

export async function probeGateway(
  input: ProviderGatewayProbeInput,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ProviderGatewayProbeResult> {
  const gateway = input.gateway;
  const headers = {
    ...gatewayHeaders(gateway, input.environment),
    "content-type": "application/json",
    ...(gateway.protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
  };
  const base = gateway.baseUrl.trim().replace(/\/+$/, "");
  const checks: ProviderGatewayProbeResult["checks"][number][] = [];
  let models: string[] = [];
  const run = async (
    name: "models" | "stream" | "tools",
    operation: (signal: AbortSignal) => Promise<void>,
  ) => {
    try {
      await operation(AbortSignal.any([signal, AbortSignal.timeout(25_000)]));
      checks.push({
        name,
        ok: true,
        detail:
          name === "models"
            ? "Model list loaded."
            : name === "stream"
              ? "Native streaming response completed."
              : "Native tool call and arguments received. No tool was executed.",
      });
    } catch (cause) {
      // Gateways may echo credentials in errors; never forward raw bodies, URLs or fetch errors.
      checks.push({
        name,
        ok: false,
        detail: isGatewayError(cause)
          ? cause.detail
          : "Connection failed or timed out. Check the server's route, TLS and gateway availability.",
      });
    }
  };
  if (input.action === "models") {
    await run("models", async (requestSignal) => {
      const response = await request(
        `${base}${gateway.protocol === "anthropic" ? "/v1" : ""}/models`,
        { headers, signal: requestSignal, redirect: "error" },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(httpFailure(response.status));
      }
      const body = record(JSON.parse(await readBounded(response, 4 * 1024 * 1024)));
      if (!Array.isArray(body?.data))
        throw failure(
          "This gateway does not expose a compatible model list. Enter model IDs manually.",
        );
      models = [
        ...new Set(
          body.data
            .map((item: unknown) => record(item)?.id)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256,
            ),
        ),
      ].slice(0, 200);
      if (!models.length) throw failure("No model IDs were returned. Enter them manually.");
    });
  } else {
    for (const tool of [false, true]) {
      if (signal.aborted) break;
      await run(tool ? "tools" : "stream", async (requestSignal) => {
        const parameters = {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        };
        const prompt = tool
          ? "Call gateway_probe with ok=true. Do not do anything else."
          : "Reply with OK.";
        const body =
          gateway.protocol === "anthropic"
            ? {
                model: gateway.model,
                max_tokens: 256,
                stream: true,
                messages: [{ role: "user", content: prompt }],
                ...(tool
                  ? {
                      tools: [
                        {
                          name: "gateway_probe",
                          description: "Connection test only",
                          input_schema: parameters,
                        },
                      ],
                      tool_choice: { type: "tool", name: "gateway_probe" },
                    }
                  : {}),
              }
            : {
                model: gateway.model,
                max_output_tokens: 1024,
                stream: true,
                store: false,
                input: [{ role: "user", content: prompt }],
                ...(tool
                  ? {
                      tools: [
                        {
                          type: "function",
                          name: "gateway_probe",
                          description: "Connection test only",
                          parameters,
                        },
                      ],
                      tool_choice: { type: "function", name: "gateway_probe" },
                    }
                  : {}),
              };
        const response = await request(
          `${base}${gateway.protocol === "anthropic" ? "/v1/messages" : "/responses"}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: requestSignal,
            redirect: "error",
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw failure(httpFailure(response.status));
        }
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel();
          throw failure(
            "Expected native SSE streaming, but the gateway returned a different content type.",
          );
        }
        const problem = inspectGatewayStream(await readBounded(response), gateway.protocol, tool);
        if (problem) throw failure(problem);
      });
    }
  }
  return { models, checks };
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  return ProviderGateway.of({
    probe: (input) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(() => failure("Could not read instance settings.")),
        );
        const instance = deriveProviderInstanceConfigMap(current)[input.instanceId];
        if (!instance) return yield* failure("Provider instance not found.");
        const problem = gatewayProblem(instance.driver, input.gateway);
        if (problem) return yield* failure(problem);
        const environment = yield* Effect.try({
          try: () => resolveGatewaySecrets(input.environment, instance.environment ?? []),
          catch: () => failure("Saved gateway credentials are unavailable. Enter them again."),
        });
        return yield* Effect.tryPromise({
          try: (signal) => probeGateway({ ...input, environment }, signal),
          catch: () => failure("Check the gateway credentials and custom header values."),
        });
      }),
  });
});

export const layer = Layer.effect(ProviderGateway, make);
