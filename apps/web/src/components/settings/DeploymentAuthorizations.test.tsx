// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  type DeploymentAuthorizationRequest,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ request: vi.fn(), admin: vi.fn(), profiles: vi.fn() }));
vi.mock("../../state/resources", () => ({
  resources: { applications: "request", deploymentAdmin: "admin" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (kind: string) => (kind === "admin" ? fixture.admin : fixture.request),
}));
vi.mock("../../i18n", () => ({ useT: () => (source: string) => source }));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "color" }));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  StageBackdropButtonArt: () => null,
}));
import { DeploymentAuthorizations } from "./DeploymentAuthorizations";

const environmentId = EnvironmentId.make("remote-environment");
const pending: DeploymentAuthorizationRequest = {
  requestId: "a".repeat(32),
  revision: "b".repeat(64),
  instanceId: ProviderInstanceId.make("codex"),
  runtimeUser: "root",
  networkNamespace: "/run/netns/codex",
  createdAt: "2026-10-05T00:00:00Z",
  status: "pending",
  proposal: {
    profileId: "bot",
    applicationName: "my-bot",
    projectRoot: "/projects/bot",
    runtimeIdentity: "root",
    network: "instance",
    listenPorts: [],
    build: { memoryMiB: 1024, cpuPercent: 100, tasks: 128, timeoutSeconds: 900 },
    runtime: { memoryMiB: 256, cpuPercent: 50, tasks: 64, timeoutSeconds: 60 },
  },
};
const grant = {
  ...pending.proposal,
  id: "bot",
  revision: "c".repeat(64),
  instances: ["codex"],
  runtimeUser: "root",
  networkNamespace: pending.networkNamespace,
  rootFilesystem: "private",
};
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(() => button(label).click());
}
async function render(instance = "codex") {
  await act(() =>
    root.render(
      <DeploymentAuthorizations
        key={instance}
        environmentId={environmentId}
        instanceId={instance}
        onProfiles={fixture.profiles}
      />,
    ),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.request
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ deploymentRequests: [pending], deploymentProfiles: [] }),
    );
  fixture.admin.mockReset().mockResolvedValue(
    AsyncResult.success({
      deploymentRequests: [{ ...pending, status: "approved" }],
      deploymentProfiles: [grant],
    }),
  );
  fixture.profiles.mockReset();
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

it("requires a review and explicit root confirmation, then sends the exact revision over the admin command", async () => {
  expect(fixture.admin).not.toHaveBeenCalled();
  await click("Review request");
  expect(container.textContent).toContain("/projects/bot");
  expect(container.textContent).toContain("/run/netns/codex");
  expect(container.textContent).toContain("Memory (MiB): 256");
  expect(button("Approve authorization").disabled).toBe(true);
  await act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("Approve authorization");
  expect(fixture.admin).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      instanceId: "codex",
      request: {
        action: "approve",
        input: { requestId: pending.requestId, revision: pending.revision, confirmRoot: true },
      },
    },
  });
  expect(fixture.profiles).toHaveBeenLastCalledWith([grant]);
  expect(container.textContent).toContain("approved");
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
});

it("lets users adjust a Harness draft and reviews the saved replacement before granting it", async () => {
  await click("Review request");
  await click("Adjust request");
  const fieldset = [...container.querySelectorAll("fieldset")].find(
    (item) => item.querySelector("legend")?.textContent === "Runtime budget",
  )!;
  const memory = fieldset.querySelector("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(memory, "384");
    memory.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const replacement = {
    ...pending,
    requestId: "d".repeat(32),
    revision: "e".repeat(64),
    proposal: { ...pending.proposal, runtime: { ...pending.proposal.runtime, memoryMiB: 384 } },
  };
  fixture.request.mockResolvedValueOnce(
    AsyncResult.success({ deploymentRequests: [replacement], deploymentProfiles: [] }),
  );
  await click("Review authorization");
  expect(fixture.request).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      instanceId: "codex",
      request: { action: "deployment-propose", input: replacement.proposal },
    },
  });
  expect(fixture.admin).not.toHaveBeenCalled();
  expect(button("Approve authorization").disabled).toBe(true);
  expect(container.textContent).toContain("Memory (MiB): 384");
  await act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("Approve authorization");
  expect(fixture.admin.mock.calls[0]?.[0].input.request.input.revision).toBe(replacement.revision);
});

it("rejects a request without granting root and requires a separate revocation confirmation", async () => {
  fixture.admin.mockResolvedValueOnce(
    AsyncResult.success({
      deploymentRequests: [{ ...pending, status: "rejected" }],
      deploymentProfiles: [grant],
    }),
  );
  await click("Review request");
  await click("Reject request");
  expect(fixture.admin.mock.calls[0]?.[0].input.request).toEqual({
    action: "reject",
    input: { requestId: pending.requestId, revision: pending.revision },
  });
  await click("Revoke authorization");
  expect(fixture.admin).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Stop the application before revoking.");
  await click("Confirm revocation");
  expect(fixture.admin.mock.calls[1]?.[0].input.request).toEqual({
    action: "revoke",
    input: { profileId: "bot", revision: grant.revision },
  });
});

it("discards responses from a previous instance after switching the review context", async () => {
  let complete: ((value: ReturnType<typeof AsyncResult.success>) => void) | undefined;
  fixture.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render("claude");
  fixture.request.mockResolvedValueOnce(
    AsyncResult.success({ deploymentRequests: [], deploymentProfiles: [] }),
  );
  await render("grok");
  fixture.profiles.mockClear();
  await act(() =>
    complete?.(AsyncResult.success({ deploymentRequests: [pending], deploymentProfiles: [grant] })),
  );
  expect(fixture.profiles).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("/projects/bot");
});
