// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  subscribe: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  logout: vi.fn(),
  respond: vi.fn(),
  confirm: vi.fn(),
  open: vi.fn(),
  copy: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: fixture.subscribe,
    startProviderAuth: fixture.start,
    cancelProviderAuth: fixture.cancel,
    logoutProviderAuth: fixture.logout,
    respondProviderAuth: fixture.respond,
  },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: fixture.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../i18n", () => ({ useT: () => (source: string) => source }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    dialogs: { confirm: fixture.confirm },
    shell: { openExternal: fixture.open },
  }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: fixture.copy }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "color" }));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  StageBackdropButtonArt: () => null,
}));

import { ProviderLoginSection } from "./ProviderLoginSection";

const environmentId = EnvironmentId.make("remote-environment");
const instanceId = ProviderInstanceId.make("codex-personal");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.160.0",
  status: "ready",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: false },
};
const idle: ProviderAuthState = {
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const waiting: ProviderAuthState = {
  ...idle,
  phase: "waiting",
  flowId: "flow-one",
  interaction: {
    type: "deviceCode",
    id: "flow-one",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  },
};
let root: Root;
let container: HTMLDivElement;
let state: ProviderAuthState;
async function render(currentProvider = provider, readOnly = false) {
  fixture.query.mockReturnValue({
    data: readOnly ? null : state,
    error: null,
    refresh: fixture.refresh,
  });
  await act(() =>
    root.render(
      <ProviderLoginSection
        environmentId={environmentId}
        environmentLabel="Remote server"
        instanceId={instanceId}
        provider={currentProvider}
        readOnly={readOnly}
        driver={
          currentProvider.driver === "claudeAgent"
            ? "claudeAgent"
            : currentProvider.driver === "grok"
              ? "grok"
              : "codex"
        }
      />,
    ),
  );
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  )!;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(fixture)) mock.mockReset();
  for (const command of [fixture.start, fixture.cancel, fixture.logout, fixture.respond])
    command.mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.confirm.mockResolvedValue(false);
  state = idle;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Provider account login", () => {
  it("starts only on user request and targets the selected remote instance", async () => {
    expect(fixture.start).not.toHaveBeenCalled();
    await act(() => button("Sign in with ChatGPT").click());
    expect(fixture.start).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });
  it("opens the official page, copies the code and cancels the active flow", async () => {
    state = waiting;
    await render();
    expect(container.textContent).toContain("ABCD-1234");
    await act(() => button("Open authorization page").click());
    expect(fixture.open).toHaveBeenCalledWith(
      waiting.interaction!.type === "deviceCode" ? waiting.interaction!.url : "",
    );
    await act(() => button("Copy code").click());
    expect(fixture.copy).toHaveBeenCalledWith("ABCD-1234", "Codex sign-in code");
    await act(() => button("Cancel sign-in").click());
    expect(fixture.cancel).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-one" },
    });
    state = { ...idle, phase: "cancelled" };
    await render();
    expect(container.textContent).not.toContain("ABCD-1234");
    expect(button("Retry sign-in")).toBeDefined();
  });
  it("does not let another client restart or cancel a pending login", async () => {
    state = {
      ...waiting,
      flowId: null,
      interaction: null,
      message: "Sign-in is in progress in another client.",
    };
    await render();
    expect(container.textContent).not.toContain("ABCD-1234");
    expect(button("Cancel sign-in")).toBeUndefined();
    expect(button("Sign in with ChatGPT")).toBeUndefined();
  });
  it("keeps an existing login until sign-out is confirmed", async () => {
    await render({ ...provider, auth: { status: "authenticated" } });
    expect(button("Sign in with ChatGPT")).toBeUndefined();
    await act(() => button("Sign out").click());
    expect(fixture.logout).not.toHaveBeenCalled();
    fixture.confirm.mockResolvedValue(true);
    await act(() => button("Sign out").click());
    expect(fixture.logout).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });
  it("does not subscribe to private login state for a read-only connection", async () => {
    fixture.subscribe.mockClear();
    await render(provider, true);
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(button("Sign in with ChatGPT")).toBeUndefined();
  });
  it("blocks duplicate requests until the command finishes", async () => {
    let finish!: (result: unknown) => void;
    fixture.start.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(() => {
      button("Sign in with ChatGPT").click();
      button("Sign in with ChatGPT").click();
    });
    expect(fixture.start).toHaveBeenCalledOnce();
    await act(() => finish({ _tag: "Success", value: undefined }));
  });
  it("submits a Claude authorization code to the original flow and clears the input", async () => {
    const claude = { ...provider, driver: ProviderDriverKind.make("claudeAgent") };
    state = {
      ...waiting,
      interaction: {
        type: "authorizationCode",
        id: "claude-login",
        url: "https://claude.ai/oauth/authorize?fixture",
      },
    };
    await render(claude);
    expect(container.textContent).toContain("paste the code it gives you below");
    expect(button("Copy code")).toBeUndefined();
    await act(() => button("Open authorization page").click());
    expect(fixture.open).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?fixture");
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(button("Submit authorization code").disabled).toBe(true);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "fixture-code#state",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => button("Submit authorization code").click());
    expect(fixture.respond).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        flowId: "flow-one",
        interactionId: "claude-login",
        response: { type: "authorizationCode", code: "fixture-code#state" },
      },
    });
    expect(input.value).toBe("");
    state = { ...state, phase: "verifying", interaction: null };
    await render(claude);
    expect(container.querySelector("input")).toBeNull();
  });
  it("clears an unfinished authorization code when a new flow replaces it", async () => {
    state = {
      ...waiting,
      interaction: {
        type: "authorizationCode",
        id: "one",
        url: "https://claude.ai/oauth/authorize?fixture",
      },
    };
    await render({ ...provider, driver: ProviderDriverKind.make("claudeAgent") });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "old-code",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    state = {
      ...state,
      flowId: "new-flow",
      interaction: {
        type: "authorizationCode",
        id: "new-flow",
        url: "https://claude.ai/oauth/authorize?new",
      },
    };
    await render({ ...provider, driver: ProviderDriverKind.make("claudeAgent") });
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
  });
  it("offers Grok sign-in and preserves the same instance target", async () => {
    await render({ ...provider, driver: ProviderDriverKind.make("grok") });
    await act(() => button("Sign in with Grok").click());
    expect(fixture.start).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });
});
