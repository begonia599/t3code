import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type LocalMcpAddDecision,
  type LocalMcpAddProposal,
} from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { useInterfaceLanguage, useT } from "~/i18n";
import { useEnvironments } from "~/state/environments";
import { useProject, useThreadShell } from "~/state/entities";

import { localMcpAvailable, readLocalMcpBridge } from "../settings/LocalMcpSettings";
import { discoverySourceApps, formatCommandLine } from "../settings/localMcp.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { bridgeErrorMessage, formatCountdown, providerLabel } from "./remoteControl.logic";
import { usePendingGrantRequests } from "./useRemoteControl";

type Decision = LocalMcpAddDecision["decision"];

function usePendingMcpProposals() {
  const [value, setValue] = useState<readonly LocalMcpAddProposal[] | null>(null);
  useEffect(() => {
    const bridge = localMcpAvailable() ? readLocalMcpBridge() : null;
    if (!bridge || typeof bridge.listAddProposals !== "function") return;
    let active = true;
    const unsubscribe = bridge.onAddProposalsChanged((next) => {
      if (active) setValue(next);
    });
    bridge.listAddProposals().then(
      (next) => {
        if (active) setValue(next);
      },
      () => {
        /* The next push brings the list; nothing to show meanwhile. */
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const reload = useCallback(() => {
    readLocalMcpBridge()
      ?.listAddProposals()
      .then(setValue, () => {});
  }, []);
  return { value, reload };
}

/**
 * Asks the user before an agent's suggested MCP server is added to this PC.
 * Main issues the proposals and only accepts ids it issued. Like the command
 * approval, it closes only through an explicit answer, and it waits while a
 * command approval is open so the two never stack.
 */
export function LocalMcpProposalDialogHost() {
  const { value: pending, reload } = usePendingMcpProposals();
  const grants = usePendingGrantRequests();
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const queue = useMemo(
    () =>
      [...(pending ?? [])]
        .filter((proposal) => !answered.has(proposal.proposalId))
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
    [pending, answered],
  );
  const waitingOnGrant = (grants.value?.length ?? 0) > 0;
  const current = waitingOnGrant ? null : (queue[0] ?? null);
  // Keep the last proposal on screen while the popup animates out.
  const [lastShown, setLastShown] = useState<LocalMcpAddProposal | null>(null);
  if (current && current !== lastShown) setLastShown(current);
  const shown = current ?? lastShown;
  const denyRef = useRef<HTMLButtonElement>(null);

  if (!shown) return null;

  return (
    <Dialog
      open={current !== null}
      disablePointerDismissal
      onOpenChange={(_open, event) => event.cancel()}
    >
      <DialogPopup className="max-w-xl" showCloseButton={false} initialFocus={denyRef}>
        <ProposalContent
          key={shown.proposalId}
          proposal={shown}
          queueLength={queue.length}
          denyRef={denyRef}
          onAnswered={(id) => setAnswered((set) => new Set(set).add(id))}
          onStale={reload}
        />
      </DialogPopup>
    </Dialog>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ProposalContent({
  proposal,
  queueLength,
  denyRef,
  onAnswered,
  onStale,
}: {
  proposal: LocalMcpAddProposal;
  queueLength: number;
  denyRef: RefObject<HTMLButtonElement | null>;
  onAnswered: (proposalId: string) => void;
  onStale: () => void;
}) {
  const t = useT();
  const now = useNow(1000);
  const listSeparator = useInterfaceLanguage() === "zh-CN" ? "、" : ", ";
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The popup stays open between queued proposals, so its initial focus only covers
  // the first; each next one starts on Deny as well.
  useEffect(() => {
    denyRef.current?.focus();
  }, [denyRef]);
  const { presentationById } = useEnvironments();
  const environmentId = EnvironmentId.make(proposal.environmentId);
  const serverLabel = presentationById.get(environmentId)?.entry.target.label ?? t("a server");
  const threadShell = useThreadShell(
    proposal.threadId ? scopeThreadRef(environmentId, ThreadId.make(proposal.threadId)) : null,
  );
  const project = useProject(
    threadShell ? scopeProjectRef(environmentId, threadShell.projectId) : null,
  );
  const agent = providerLabel(proposal.provider);
  const expiresAt = Date.parse(proposal.expiresAt);
  const discovered = proposal.origin === "discovered";
  const apps = discoverySourceApps(proposal.sources ?? []).join(listSeparator);
  const { transport } = proposal;
  const secretNames = transport.type === "stdio" ? transport.envNames : transport.headerNames;
  // An agent's own proposal carries the values it wrote, so the user sees exactly
  // what gets saved; values found in other apps never leave main.
  const writtenValues = Object.entries(
    (transport.type === "stdio" ? transport.env : transport.headers) ?? {},
  );
  const valueLines = writtenValues.map(([name, value]) =>
    transport.type === "stdio" ? `${name}=${value}` : `${name}: ${value}`,
  );
  // Running a command the agent wrote is the one case worth a second look.
  const caution = !discovered && transport.type === "stdio";

  const answer = async (decision: Decision) => {
    const bridge = readLocalMcpBridge();
    if (!bridge || busy) return;
    setBusy(decision);
    setError(null);
    try {
      await bridge.resolveAddProposal({ proposalId: proposal.proposalId, decision });
      onAnswered(proposal.proposalId);
    } catch (cause) {
      // Usually expired, withdrawn by the agent, or answered in another window.
      setError(bridgeErrorMessage(cause));
      onStale();
    } finally {
      setBusy(null);
    }
  };

  const description = discovered
    ? t("An agent on {server} wants to use {name}, which is already set up in {apps}.")
        .replace("{server}", serverLabel)
        .replace("{name}", proposal.name)
        .replace("{apps}", apps)
    : t("An agent on {server} suggests adding {name} to this computer.")
        .replace("{server}", serverLabel)
        .replace("{name}", proposal.name);

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3">
          <span
            className={
              caution
                ? "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning-foreground"
                : "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            }
          >
            <PlugIcon className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <DialogTitle>{t("Add an MCP server to this computer?")}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
          {queueLength > 1 ? (
            <Badge variant="outline" className="mt-1 shrink-0">
              {t("{count} waiting").replace("{count}", String(queueLength))}
            </Badge>
          ) : null}
        </div>
      </DialogHeader>
      <DialogPanel>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
          <DetailRow label={t("Name")}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{proposal.name}</span>
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                {proposal.id}__
              </span>
            </span>
          </DetailRow>
          <DetailRow label={t("Thread")}>
            {threadShell ? (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{threadShell.title}</span>
                {project ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{project.title}</span>
                ) : null}
              </span>
            ) : proposal.threadId ? (
              <span className="truncate font-mono text-xs">{proposal.threadId}</span>
            ) : (
              <span className="text-muted-foreground">{t("Not in a thread")}</span>
            )}
          </DetailRow>
          {agent || proposal.label ? (
            <DetailRow label={t("Agent")}>
              <span className="flex min-w-0 items-baseline gap-1.5">
                {agent ? <span className="shrink-0">{agent}</span> : null}
                {proposal.label ? (
                  <span className="truncate text-muted-foreground">{proposal.label}</span>
                ) : null}
              </span>
            </DetailRow>
          ) : null}
          {transport.type === "stdio" && transport.cwd ? (
            <DetailRow label={t("Working folder")}>
              <span className="block font-mono text-xs leading-5 break-all">{transport.cwd}</span>
            </DetailRow>
          ) : null}
        </dl>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {transport.type === "stdio" ? t("Command") : t("URL")}
          </p>
          <pre className="max-h-40 overflow-auto rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
            {transport.type === "stdio"
              ? formatCommandLine(transport.command, transport.args)
              : transport.url}
          </pre>
          {valueLines.length === 0 && secretNames.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              <span>
                {transport.type === "stdio" ? t("Environment variables") : t("Headers")}
                {listSeparator === "、" ? "：" : ": "}
              </span>
              <span className="font-mono text-2xs text-foreground">
                {secretNames.join(listSeparator)}
              </span>
              {discovered ? <span> {t("(values stay on this computer)")}</span> : null}
            </p>
          ) : null}
        </div>
        {valueLines.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {transport.type === "stdio" ? t("Environment variables") : t("Headers")}
            </p>
            <pre className="max-h-32 overflow-auto rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
              {valueLines.join("\n")}
            </pre>
          </div>
        ) : null}
        {caution ? (
          <p className="text-xs leading-relaxed text-warning-foreground">
            {t(
              "This command runs on this computer every time the server starts. Add it only if you trust it.",
            )}
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            "Once added, agents can use its tools. You can turn it off or remove it anytime in Settings → MCP servers on this PC.",
          )}
        </p>
        {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <span className="text-xs text-muted-foreground tabular-nums sm:me-auto sm:self-center">
          {Number.isFinite(expiresAt)
            ? t("Expires in {time}").replace("{time}", formatCountdown(expiresAt, now))
            : null}
        </span>
        <Button
          ref={denyRef}
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void answer("deny")}
        >
          {t("Deny")}
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void answer("add")}>
          {busy === "add" ? <Spinner className="size-3.5" /> : null}
          {t("Add")}
        </Button>
      </DialogFooter>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
