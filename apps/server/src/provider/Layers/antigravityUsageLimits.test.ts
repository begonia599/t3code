import { ProviderDriverKind } from "@t3tools/contracts";
import { collectLimitPools, displayLimitWindows } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vitest";

import { parseAntigravityUsageLimits } from "./antigravityUsageLimits.ts";

const report = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash)*
  - **Weekly Limit Remaining:** 98% remaining (resets Nov 24, 2026, 14:00 UTC)
  - **Five Hour Limit Remaining:** 98% remaining (resets Nov 18, 2026, 00:00 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B)*
  - **Weekly Limit Remaining:** 100% remaining (resets Nov 24, 2026, 14:46 UTC)
  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 18, 2026, 02:08 UTC)`;

describe("Antigravity /usage", () => {
  it("keeps both weekly and five-hour windows for each model group", () => {
    expect(parseAntigravityUsageLimits(report)).toEqual({
      status: "ok",
      windows: [
        {
          id: "gemini-models-weekly-limit-remaining",
          label: "Gemini · Weekly",
          kind: "weekly",
          windowDurationMins: 10080,
          usedPercent: 2,
          resetsAt: "2026-11-24T14:00:00.000Z",
        },
        {
          id: "gemini-models-five-hour-limit-remaining",
          label: "Gemini · 5-hour",
          kind: "session",
          windowDurationMins: 300,
          usedPercent: 2,
          resetsAt: "2026-11-18T00:00:00.000Z",
        },
        {
          id: "claude-and-gpt-models-weekly-limit-remaining",
          label: "Claude/GPT · Weekly",
          kind: "weekly",
          windowDurationMins: 10080,
          usedPercent: 0,
          resetsAt: "2026-11-24T14:46:00.000Z",
        },
        {
          id: "claude-and-gpt-models-five-hour-limit-remaining",
          label: "Claude/GPT · 5-hour",
          kind: "session",
          windowDurationMins: 300,
          usedPercent: 0,
          resetsAt: "2026-11-18T02:08:00.000Z",
        },
      ],
    });
  });

  it("keeps all four report rows through the shared Limits view", () => {
    const result = parseAntigravityUsageLimits(report);
    if (result.status !== "ok") throw new Error("Expected the captured quota report");
    const checkedAt = "2026-11-17T21:00:00.000Z";
    const [pool] = collectLimitPools(
      [
        {
          key: "test-account",
          driver: ProviderDriverKind.make("antigravity"),
          displayName: null,
          email: undefined,
          plan: undefined,
          accentColor: undefined,
          environments: [],
          sourceLabel: null,
          redeem: null,
          limits: { checkedAt, windows: result.windows },
        },
      ],
      Date.parse(checkedAt),
    );
    expect(
      displayLimitWindows(pool!).map(({ label, remainingPercent, resets }) => [
        label,
        remainingPercent,
        resets[0]?.at,
      ]),
    ).toEqual([
      ["Gemini · 5-hour", 98, Date.parse("2026-11-18T00:00:00Z")],
      ["Claude/GPT · 5-hour", 100, Date.parse("2026-11-18T02:08:00Z")],
      ["Gemini · Weekly", 98, Date.parse("2026-11-24T14:00:00Z")],
      ["Claude/GPT · Weekly", 100, Date.parse("2026-11-24T14:46:00Z")],
    ]);
  });
  it.each([
    ["- Unable to retrieve quota status (service error)", "probeFailed"],
    ["- Not applicable for current authentication method.", "unsupported"],
    ["- data not available yet", "noData"],
    ["- No quota limits reported.", "noData"],
    ["- **Gemini Models**\n  - No active bucket limits", "noData"],
    ...[
      "Disabled",
      "Disabled: plan unavailable",
      "1,234 units remaining",
      "Available (resets Nov 24, 2026, 14:00 UTC)",
    ].map((status) => [`- **Gemini Models**\n  - **Weekly Limit Remaining:** ${status}`, "noData"]),
  ])("decodes %s", (body, status) => {
    expect(parseAntigravityUsageLimits(`### Quota Limits\n${body}`)).toEqual({ status });
  });

  it("preserves unknown names and omits unavailable dates and non-percentage buckets", () => {
    const body = [
      "### Quota Limits",
      "- **Future Group**",
      "  - **5 Hour:** 0% remaining",
      "  - **5h:** 49% remaining (resets unknown)",
      "  - **Burst:** 32% remaining",
      "  - **Other:** Disabled: previously 25% remaining",
      "### Other",
      "- **Wrong group**",
      "  - **Burst:** 20% remaining",
    ].join("\r\n");
    expect(parseAntigravityUsageLimits(body)).toEqual({
      status: "ok",
      windows: [
        {
          id: "future-group-5-hour",
          kind: "session",
          windowDurationMins: 300,
          label: "Future Group · 5-hour",
          usedPercent: 100,
        },
        {
          id: "future-group-5h",
          kind: "session",
          windowDurationMins: 300,
          label: "Future Group · 5-hour",
          usedPercent: 51,
        },
        { id: "future-group-burst", kind: "other", label: "Future Group · Burst", usedPercent: 68 },
      ],
    });
  });
  it("treats a missing or unrecognized quota report as a failed probe", () => {
    for (const text of [
      "",
      "### Session Usage\n- data not available yet",
      "### Quota Limits\nUnexpected response",
    ]) {
      expect(parseAntigravityUsageLimits(text)).toEqual({ status: "probeFailed" });
    }
  });
});
