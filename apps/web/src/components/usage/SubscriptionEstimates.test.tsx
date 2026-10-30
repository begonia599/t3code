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
  it("excludes and restores observations in the selected environment", async () => {
    act(() => {
      renderer = create(<SubscriptionEstimates environmentId={environmentId} label="Server one" />);
    });
    await act(async () => {
      await button("Exclude: used elsewhere during this interval").props.onClick();
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
      await button("Exclude: used elsewhere during this interval").props.onClick();
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
    expect(button("Exclude: used elsewhere during this interval").props.disabled).toBe(true);
  });
});
