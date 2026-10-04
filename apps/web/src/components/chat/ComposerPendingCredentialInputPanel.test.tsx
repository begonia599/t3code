// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type CredentialInputRequest,
} from "@t3tools/contracts";
import type { ResourceMutation } from "@t3tools/client-runtime/state/resources";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ execute: vi.fn(), snapshot: vi.fn(), read: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: fixture.read }));
vi.mock("../../state/resources", () => ({
  resources: { mutate: Symbol("mutate"), snapshot: fixture.snapshot },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.execute }));
vi.mock("../../i18n", () => ({ useT: () => (source: string) => source }));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "color" }));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  StageBackdropButtonArt: () => null,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ComposerPendingCredentialInputPanel } from "./ComposerPendingCredentialInputPanel";

const environmentId = EnvironmentId.make("credential-environment");
const threadId = ThreadId.make("credential-thread");
const request: CredentialInputRequest = {
  id: "request-one",
  name: "APP_KEY",
  description: "Key for the application's API",
  purpose: "Test the translation API",
  valueType: "token",
  usage: "shell-and-bindings",
  instanceId: ProviderInstanceId.make("claudeAgent"),
  threadId,
  createdAt: Date.now(),
};
const secret = "fixture-private-answer";
let container: HTMLDivElement;
let root: Root;
let requests: CredentialInputRequest[];
const chatSubmit = vi.fn();
const chatPaste = vi.fn();

async function render() {
  fixture.read.mockReturnValue(
    AsyncResult.success({ vault: { credentials: [], requests, grants: [] }, mcp: [], tools: [] }),
  );
  await act(() => {
    root.render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          chatSubmit();
        }}
        onPaste={chatPaste}
      >
        <ComposerPendingCredentialInputPanel environmentId={environmentId} threadId={threadId} />
        <textarea aria-label="Chat draft" defaultValue="Existing chat draft" />
      </form>,
    );
  });
}
function privateInput() {
  return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "[data-credential-input-request] input, [data-credential-input-request] textarea",
  )!;
}
async function typeValue(value = secret) {
  const input = privateInput();
  const prototype =
    input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submitButton() {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Submit" || button.textContent === "Submitting...",
  )!;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.execute.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  fixture.snapshot.mockClear();
  chatSubmit.mockClear();
  chatPaste.mockClear();
  requests = [request];
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

describe("private answers in the native question panel", () => {
  it("shows a password answer for a standard thread subscription and can collapse and reopen it", async () => {
    expect(fixture.snapshot).toHaveBeenCalledWith({ environmentId, input: { threadId } });
    expect(privateInput().type).toBe("password");
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain(request.purpose);
    expect(container.textContent).not.toContain("Allowed provider instances");
    const toggle = container.querySelector<HTMLButtonElement>("[data-pending-user-input-toggle]")!;
    await typeValue();
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(privateInput().value).toBe(secret);
  });

  it("submits Enter only to the vault and leaves the chat draft untouched", async () => {
    await typeValue();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(() => privateInput().dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(chatSubmit).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Chat draft"]')!.value).toBe(
      "Existing chat draft",
    );
    expect(fixture.execute).toHaveBeenCalledOnce();
    const mutation = fixture.execute.mock.calls[0]![0].input as ResourceMutation;
    expect(mutation.type).toBe("write");
    if (mutation.type !== "write" || !mutation.payload.value)
      throw new Error("Expected private write");
    expect(Redacted.value(mutation.payload.value)).toBe(secret);
    expect(mutation.payload.requestId).toBe(request.id);
    expect(mutation.payload.allowedInstances).toEqual([request.instanceId]);
    expect(privateInput().value).toBe("");
  });

  it("keeps paste and a failed submission out of chat, then allows retry", async () => {
    await typeValue();
    await act(() => privateInput().dispatchEvent(new Event("paste", { bubbles: true })));
    expect(chatPaste).not.toHaveBeenCalled();
    fixture.execute.mockRejectedValueOnce(new Error("Failed private write"));
    await act(() => submitButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Please try again");
    expect(privateInput().value).toBe(secret);
    await act(() => submitButton().click());
    expect(privateInput().value).toBe("");
    expect(chatSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while confirming an IME composition", async () => {
    await typeValue();
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => privateInput().dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(chatSubmit).not.toHaveBeenCalled();
  });

  it("only writes once when submit is clicked twice before the request completes", async () => {
    await typeValue();
    let finishWrite = () => {};
    const pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    fixture.execute.mockReturnValueOnce(pending.then(() => AsyncResult.success(undefined)));
    await act(() => {
      const button = submitButton();
      button.click();
      button.click();
    });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(submitButton().disabled).toBe(true);
    await act(() => finishWrite());
    expect(privateInput().value).toBe("");
  });

  it("does not reuse a private answer for the next queued request", async () => {
    await typeValue();
    requests = [{ ...request, id: "request-two", name: "SECOND_KEY" }];
    await render();
    expect(privateInput().value).toBe("");
    expect(container.textContent).toContain("SECOND_KEY");
    requests = [];
    await render();
    expect(container.querySelector("[data-credential-input-request]")).toBeNull();
  });

  it("allows multiline text and dismisses through the resource API without sending chat", async () => {
    requests = [{ ...request, id: "text-request", valueType: "text" }];
    await render();
    await typeValue("line one\nline two");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(() => privateInput().dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
    expect(fixture.execute).not.toHaveBeenCalled();
    await act(() =>
      container.querySelector<HTMLElement>("[data-pending-user-input-dismiss]")!.click(),
    );
    expect(fixture.execute).toHaveBeenCalledWith({
      environmentId,
      input: { type: "action", payload: { action: "dismiss", id: "text-request" } },
    });
    expect(privateInput().value).toBe("");
    expect(chatSubmit).not.toHaveBeenCalled();
  });
});
