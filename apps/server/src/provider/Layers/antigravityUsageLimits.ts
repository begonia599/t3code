import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { AcpError } from "effect-acp/errors";

import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";

export type AntigravityQuota =
  | { readonly status: "ok"; readonly windows: readonly ServerProviderUsageWindow[] }
  | { readonly status: "noData" | "unsupported" | "probeFailed" };

function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

function windowPeriod(name: string) {
  if (/weekly/i.test(name)) return { kind: "weekly", windowDurationMins: 10_080 } as const;
  if (/five hour|5 hour|5h/i.test(name))
    return { kind: "session", windowDurationMins: 300 } as const;
  return { kind: "other" } as const;
}

function resetTime(date: string | undefined) {
  if (!date || !/^[A-Z][a-z]{2} \d{2}, \d{4}, \d{2}:\d{2} UTC$/.test(date)) return undefined;
  // DateTime recognizes GMT as an explicit zone in agy's English month format.
  return DateTime.make(date.replace(/ UTC$/, " GMT")).pipe(
    Option.map(DateTime.formatIso),
    Option.getOrUndefined,
  );
}

/** Reads only the Quota Limits section emitted by the native slash command. */
export function parseAntigravityUsageLimits(markdown: string): AntigravityQuota {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.indexOf("### Quota Limits");
  if (heading < 0) return { status: "probeFailed" };
  const windows: ServerProviderUsageWindow[] = [];
  let group: string | undefined;
  let noData = false;
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith("#")) break;
    if (line.startsWith("- Unable to retrieve quota status")) return { status: "probeFailed" };
    if (line === "- Not applicable for current authentication method.")
      return { status: "unsupported" };
    if (
      line === "- data not available yet" ||
      line === "- No quota limits reported." ||
      line === "  - No active bucket limits"
    ) {
      noData = true;
      continue;
    }
    const groupLine = /^- \*\*(.+)\*\*$/.exec(line);
    if (groupLine) {
      group = groupLine[1];
      continue;
    }
    const bucket = /^  - \*\*(.+):\*\* (.+)$/.exec(line);
    const [, name, value] = bucket ?? [];
    if (!group || !name || !value) continue;
    const match = /^(\d+)% remaining(?: \(resets (.+)\))?$/.exec(value);
    if (!match || Number(match[1]) > 100) {
      if (/^(?:Disabled(?:$|:)|Available\b|[\d,]+ units remaining\b)/.test(value)) noData = true;
      continue;
    }
    const period = windowPeriod(name);
    const resetsAt = resetTime(match[2]);
    const groupLabel =
      group === "Gemini Models"
        ? "Gemini"
        : group === "Claude and GPT models"
          ? "Claude/GPT"
          : group;
    const bucketLabel =
      period.kind === "session" ? "5-hour" : period.kind === "weekly" ? "Weekly" : name;
    windows.push({
      id: `${slug(group)}-${slug(name)}`,
      label: `${groupLabel} · ${bucketLabel}`,
      ...period,
      usedPercent: 100 - Number(match[1]),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length ? { status: "ok", windows } : { status: noData ? "noData" : "probeFailed" };
}

/** A disposable session owns this event queue. Older agents would send an unknown command to the model. */
export const readAntigravityQuota = Effect.fn("readAntigravityQuota")(function* (
  runtime: Pick<AcpSessionRuntime["Service"], "getEvents" | "drainEvents" | "prompt">,
) {
  const advertised = yield* Deferred.make<boolean, AcpError>();
  const chunks: string[] = [];
  yield* Stream.runForEach(runtime.getEvents(), (event) => {
    switch (event._tag) {
      case "AvailableCommandsUpdated":
        return Deferred.succeed(
          advertised,
          event.availableCommands.some((cmd) => cmd.name === "usage"),
        ).pipe(Effect.asVoid);
      case "ConnectionTerminated":
        return Deferred.fail(advertised, event.error).pipe(Effect.asVoid);
      case "EventStreamBarrier":
        return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
      case "ContentDelta":
        chunks.push(event.text);
    }
    return Effect.void;
  }).pipe(Effect.forkScoped);
  if (!(yield* Deferred.await(advertised))) return { status: "unsupported" } as const;
  const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "/usage" }] });
  yield* runtime.drainEvents;
  return response.stopReason === "end_turn"
    ? parseAntigravityUsageLimits(chunks.join(""))
    : ({ status: "probeFailed" } as const);
}, Effect.scoped);
