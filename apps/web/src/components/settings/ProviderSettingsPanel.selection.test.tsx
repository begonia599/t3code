// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  updateSettings: vi.fn(),
  updateClientSettings: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  useUpdateEnvironmentSettings: () => state.updateSettings,
  useUpdateClientSettings: () => state.updateClientSettings,
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => null,
    refreshProviders: null,
    updateProvider: null,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: () => null,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PolicyTooltip: () => null,
  SettingResetButton: () => null,
  useSettingsSearchTargetId: () => null,
  useRelativeTimeTick: () => undefined,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./UsageProviderSettings", () => ({ UsageProviderSettings: () => null }));

// Keep the real parent and React reconciliation. The card's fragment and its
// sibling configuration button must be removed when another instance is chosen.
vi.mock("./ProviderInstanceCard", () => ({
  ProviderInstanceCard: ({
    instanceId,
    mode,
    onSelect,
  }: {
    instanceId: string;
    mode: "list" | "editor";
    onSelect?: () => void;
  }) =>
    mode === "list" ? (
      <button onClick={onSelect}>Select {instanceId}</button>
    ) : (
      <>
        <section aria-label="Provider configuration">{instanceId}</section>
        <section aria-label="Provider models">{instanceId}</section>
      </>
    ),
}));
vi.mock("./NativeConfigEditor", () => ({
  NativeConfigEditorButton: ({ instanceId }: { instanceId: string }) => (
    <button aria-label="Native configuration">{instanceId}</button>
  ),
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("codex_work")]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
      },
    },
  };
  state.updateSettings.mockClear();
  state.updateClientSettings.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "replaces provider forms on repeated selection (read only: %s)",
  async (readOnly) => {
    await act(async () => {
      root.render(
        <EnvironmentProviderSettings
          environmentId={EnvironmentId.make("test-environment")}
          environmentLabel="Test environment"
          readOnly={readOnly}
        />,
      );
    });

    for (let round = 0; round < 3; round++) {
      for (const instanceId of ["codex", "grok", "claudeAgent", "codex_work", "codex"]) {
        const button = [...container.querySelectorAll("button")].find(
          (node) => node.textContent === `Select ${instanceId}`,
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());

        for (const label of ["Provider configuration", "Provider models"]) {
          const sections = container.querySelectorAll(`[aria-label="${label}"]`);
          expect([...sections].map((node) => node.textContent)).toEqual([instanceId]);
        }
        const nativeButtons = container.querySelectorAll('[aria-label="Native configuration"]');
        expect([...nativeButtons].map((node) => node.textContent)).toEqual(
          instanceId === "grok" ? [] : [instanceId],
        );
      }
    }
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.updateClientSettings).not.toHaveBeenCalled();
  },
);
