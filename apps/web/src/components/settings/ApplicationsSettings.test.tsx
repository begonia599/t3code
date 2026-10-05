// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    providerInstances: { codex: { execution: {} }, grok: { execution: {} } },
  }),
}));
vi.mock("../../state/resources", () => ({ resources: { applications: fixture.execute } }));
vi.mock("../../state/server", () => ({ serverEnvironment: { settingsValueAtom: () => null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.execute }));
vi.mock("../../i18n", () => ({ useT: () => (source: string) => source }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "color" }));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  StageBackdropButtonArt: () => null,
}));

import { ApplicationsSettings } from "./ApplicationsSettings";

const environmentId = EnvironmentId.make("remote-environment");
const profile = {
  id: "bot",
  projectRoot: "/projects/bot",
  applicationName: "my-bot",
  runtimeUser: "root",
  build: { memoryMiB: 1024, cpuPercent: 100, tasks: 128, timeoutSeconds: 900 },
  runtime: { memoryMiB: 256, cpuPercent: 50, tasks: 64, timeoutSeconds: 60 },
  networkNamespace: "host",
  rootFilesystem: "private",
  listenPorts: [],
};
let root: Root;
let container: HTMLDivElement;
function button(text: string) {
  const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === text,
  );
  if (!node) throw new Error("Missing button: " + text);
  return node;
}
function select(label: string) {
  const node = [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith(label))
    ?.querySelector("select");
  if (!node) throw new Error("Missing selector: " + label);
  return node;
}
async function choose(label: string, value: string) {
  await act(() => {
    const node = select(label);
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.execute.mockReset().mockResolvedValue(
    AsyncResult.success({
      applications: [],
      backends: ["systemd"],
      deploymentProfiles: [profile],
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<ApplicationsSettings environmentId={environmentId} />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("publishes an authorized native bot without requiring a public endpoint", async () => {
  await act(() => button("Refresh applications").click());
  await choose("Deployment backend", "systemd");
  await choose("Deployment profile", "bot");
  expect(container.textContent).toContain("256 MiB");
  expect(container.textContent).not.toContain("Public hostname (optional)");
  const values = [...container.querySelectorAll("input")].map((node) => node.value);
  expect(values).toEqual(["/projects/bot", "application.yaml", "my-bot"]);
  fixture.execute.mockResolvedValueOnce(AsyncResult.success({}));
  await act(() => button("Publish application").click());
  expect(fixture.execute).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      instanceId: "codex",
      request: {
        action: "publish",
        input: {
          projectRoot: "/projects/bot",
          name: "my-bot",
          manifestPath: "application.yaml",
          backend: "systemd",
          deploymentProfile: "bot",
          hostname: null,
        },
      },
    },
  });
});
it("clears profile authority when switching instances and cannot publish with stale grants", async () => {
  await act(() => button("Refresh applications").click());
  await choose("Deployment backend", "systemd");
  await choose("Deployment profile", "bot");
  await choose("Provider instance", "grok");
  await choose("Deployment backend", "systemd");
  expect(select("Deployment profile").options).toHaveLength(1);
  fixture.execute.mockClear();
  await act(() => button("Publish application").click());
  expect(fixture.execute).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Select a registered deployment profile.",
  );
});
