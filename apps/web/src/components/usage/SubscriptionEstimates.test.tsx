import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  type SubscriptionEstimationReport,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  report: { samples: [], cycles: [], hasMore: false } as SubscriptionEstimationReport,
  refresh: vi.fn(),
  exclude: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../../i18n", () => ({ useT: () => (text: string) => text }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    subscriptionEstimation: (input: unknown) => input,
    excludeSubscriptionSample: {},
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.exclude }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    state.query(input);
    return { data: state.report, error: null, refresh: state.refresh };
  },
}));
import { SubscriptionEstimates } from "./SubscriptionEstimates";

let renderer: ReactTestRenderer | undefined;
const environmentId = EnvironmentId.make("environment-one");
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((b) => b.children.includes(label))!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.exclude.mockResolvedValue({ _tag: "Success" });
  state.report = {
    cycles: [],
    hasMore: true,
    samples: [
      {
        id: "one",
        accountKey: "account",
        label: "Claude",
        driver: ProviderDriverKind.make("claudeAgent"),
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:01:00.000Z",
        before: [],
        after: [],
        cycleKeys: {},
        costUsd: 0.2,
        calls: 1,
        issues: [],
        excluded: false,
        models: ["model"],
        priceSources: [],
      },
    ],
  };
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("subscription estimates controls", () => {
  it("shows live preliminary values and distinguishes references with missing child usage", () => {
    state.report = {
      ...state.report,
      cycles: [
        {
          id: "cycle",
          label: "Codex",
          windowLabel: "Weekly",
          scope: "general",
          resetsAt: "2099-01-01T00:00:00.000Z",
          samples: 1,
          observedCostUsd: 30,
          calibrationCostUsd: 30,
          usedPercentagePoints: 15,
          remainingPercent: 56,
          estimatedTotalUsd: 200,
          estimatedRemainingUsd: 112,
          preliminary: true,
        },
      ],
    };
    act(() => {
      renderer = create(<SubscriptionEstimates environmentId={environmentId} label="Server one" />);
    });
    let rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("$200");
    expect(rendered).toContain("$112");
    expect(rendered).toContain("Preliminary");
    state.report = {
      ...state.report,
      cycles: state.report.cycles.map((c) => ({
        ...c,
        estimatedTotalUsd: null,
        estimatedRemainingUsd: null,
        knownCostTotalUsd: 200,
        knownCostRemainingUsd: 112,
        knownCostPercentagePoints: 15,
      })),
    };
    act(() =>
      renderer!.update(<SubscriptionEstimates environmentId={environmentId} label="Server one" />),
    );
    rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("$200");
    expect(rendered).toContain("≥ $200");
    expect(rendered).toContain("Some task usage was incomplete; this is a lower bound");
    expect(rendered).not.toContain("Preliminary");
  });
  it("shows only unexpired windows as cards and folds past cycles away", () => {
    const base = {
      id: "current",
      label: "Claude",
      windowLabel: "Session",
      scope: "general",
      resetsAt: "2099-01-01T00:00:00.000Z",
      samples: 10,
      observedCostUsd: 6.66,
      calibrationCostUsd: 6.66,
      usedPercentagePoints: 74,
      remainingPercent: 23,
      estimatedTotalUsd: 9,
      estimatedRemainingUsd: 2.07,
    };
    state.report = {
      ...state.report,
      cycles: [
        base,
        { ...base, id: "past", resetsAt: "2000-01-01T00:00:00.000Z", estimatedTotalUsd: 5 },
        { ...base, id: "early", superseded: true, estimatedTotalUsd: 7 },
      ],
    };
    act(() => {
      renderer = create(<SubscriptionEstimates environmentId={environmentId} label="Server one" />);
    });
    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("≈ $9.00");
    expect(rendered).toContain("Past cycles");
    const tree = renderer!.toJSON() as any;
    const find = (n: any, pred: (n: any) => boolean): any =>
      n && typeof n === "object"
        ? pred(n)
          ? n
          : (n.children ?? []).map((c: any) => find(c, pred)).find(Boolean)
        : undefined;
    const cards = find(tree, (n) => n.props?.className?.includes("sm:grid-cols-2"));
    const past = find(tree, (n) => n.type === "details");
    expect(JSON.stringify(cards)).toContain("$9.00");
    expect(JSON.stringify(cards)).not.toContain("$5.00");
    expect(JSON.stringify(past)).toContain("$5.00");
    expect(JSON.stringify(cards)).not.toContain("$7.00");
    expect(JSON.stringify(past)).toContain("Reset early");
  });
  it("shows a range instead of a point when quota barely moved", () => {
    const base = {
      id: "cycle",
      label: "Claude",
      windowLabel: "Session",
      scope: "general",
      resetsAt: "2099-01-01T00:00:00.000Z",
      samples: 1,
      observedCostUsd: 0.27,
      calibrationCostUsd: 0.27,
      usedPercentagePoints: 1,
      remainingPercent: 99,
      estimatedTotalUsd: 27,
      estimatedRemainingUsd: 26.73,
      preliminary: true,
    };
    state.report = { ...state.report, cycles: [base] };
    act(() => {
      renderer = create(<SubscriptionEstimates environmentId={environmentId} label="Server one" />);
    });
    let rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("≥ $13.50");
    expect(rendered).toContain("Too little data");
    expect(rendered).not.toContain("$27.00");
    expect(rendered).not.toContain("$26.73");
    state.report = {
      ...state.report,
      cycles: [{ ...base, calibrationCostUsd: 0.8, usedPercentagePoints: 4 }],
    };
    act(() =>
      renderer!.update(<SubscriptionEstimates environmentId={environmentId} label="Server one" />),
    );
    rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("$16.00 – $26.67");
  });
  it("excludes and restores observations in the selected environment", async () => {
    act(() => {
      renderer = create(<SubscriptionEstimates environmentId={environmentId} label="Server one" />);
    });
    await act(async () => {
      await button("Exclude").props.onClick();
    });
    expect(state.exclude).toHaveBeenLastCalledWith({
      environmentId,
      input: { id: "one", excluded: true },
    });
    expect(state.refresh).toHaveBeenCalledOnce();
    state.report = {
      ...state.report,
      samples: state.report.samples.map((s) => ({ ...s, excluded: true })),
    };
    act(() =>
      renderer!.update(<SubscriptionEstimates environmentId={environmentId} label="Server one" />),
    );
    await act(async () => {
      await button("Restore sample").props.onClick();
    });
    expect(state.exclude).toHaveBeenLastCalledWith({
      environmentId,
      input: { id: "one", excluded: false },
    });
    act(() => button("Older samples").props.onClick());
    expect(state.query).toHaveBeenLastCalledWith({
      environmentId,
      input: { before: "2026-01-01T00:00:00.000Z", beforeId: "one" },
    });
    act(() => button("Latest samples").props.onClick());
    expect(state.query).toHaveBeenLastCalledWith({ environmentId, input: {} });
  });
  it("surfaces failed exclusions and keeps running intervals read-only", async () => {
    state.exclude.mockResolvedValue({ _tag: "Failure" });
    act(() => {
      renderer = create(<SubscriptionEstimates environmentId={environmentId} label="Server one" />);
    });
    await act(async () => {
      await button("Exclude").props.onClick();
    });
    expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(
      "Could not update subscription estimates.",
    );
    expect(state.refresh).not.toHaveBeenCalled();
    state.report = {
      ...state.report,
      samples: state.report.samples.map((s) => ({ ...s, endedAt: null })),
    };
    act(() =>
      renderer!.update(<SubscriptionEstimates environmentId={environmentId} label="Server one" />),
    );
    expect(button("Exclude").props.disabled).toBe(true);
  });
});
