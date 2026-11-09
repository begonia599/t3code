import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type RemoteControlGrantDecision,
  type RemoteControlGrantRequest,
} from "@t3tools/contracts";
import { ShieldQuestionIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useT } from "~/i18n";
import { useEnvironments } from "~/state/environments";
import { useProject, useThreadShell } from "~/state/entities";

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
import {
  bridgeErrorMessage,
  formatCountdown,
  orderGrantRequests,
  providerLabel,
} from "./remoteControl.logic";
import { readRemoteControlBridge, usePendingGrantRequests } from "./useRemoteControl";

type Decision = RemoteControlGrantDecision["decision"];

/**
 * Asks the user before a server agent runs its first command on this
 * computer (or every command, in strict mode). Main owns the pending list and
 * only accepts ids it issued, so this window can answer requests but never
 * invent them. The dialog only closes through an explicit answer: a stray
 * Escape must not become a denial that blocks the thread for ten minutes.
 */
export function RemoteControlGrantDialogHost() {
  const { value: pending, reload } = usePendingGrantRequests();
  // Answered ids stay hidden until main's next list drops them. Main never
  // reuses an id, so the set only holds this session's handful of answers.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const queue = useMemo(
    () =>
      orderGrantRequests(pending ?? []).filter((request) => !answered.has(request.grantRequestId)),
    [pending, answered],
  );

  const current = queue[0] ?? null;
  // Keep the last request on screen while the popup animates out.
  const [lastShown, setLastShown] = useState<RemoteControlGrantRequest | null>(null);
  if (current && current !== lastShown) setLastShown(current);
  const shown = current ?? lastShown;
  const denyRef = useRef<HTMLButtonElement>(null);

  if (!readRemoteControlBridge() || !shown) return null;

  return (
    <Dialog
      open={current !== null}
      disablePointerDismissal
      onOpenChange={(_open, event) => event.cancel()}
    >
      <DialogPopup className="max-w-xl" showCloseButton={false} initialFocus={denyRef}>
        <GrantRequestContent
          key={shown.grantRequestId}
          request={shown}
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

function GrantRequestContent({
  request,
  queueLength,
  denyRef,
  onAnswered,
  onStale,
}: {
  request: RemoteControlGrantRequest;
  queueLength: number;
  denyRef: RefObject<HTMLButtonElement | null>;
  onAnswered: (grantRequestId: string) => void;
  onStale: () => void;
}) {
  const t = useT();
  const now = useNow(1000);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { presentationById } = useEnvironments();
  const environmentId = EnvironmentId.make(request.environmentId);
  const serverLabel = presentationById.get(environmentId)?.entry.target.label ?? t("a server");
  const threadShell = useThreadShell(
    request.threadId ? scopeThreadRef(environmentId, ThreadId.make(request.threadId)) : null,
  );
  const project = useProject(
    threadShell ? scopeProjectRef(environmentId, threadShell.projectId) : null,
  );
  const agent = providerLabel(request.provider);
  // A grant is keyed by thread; without one only a single command can pass.
  const canAllowThread = !request.strictMode && request.threadId !== null;
  const expiresAt = Date.parse(request.expiresAt);

  const answer = async (decision: Decision) => {
    const bridge = readRemoteControlBridge();
    if (!bridge || busy) return;
    setBusy(decision);
    setError(null);
    try {
      await bridge.resolveGrant({ grantRequestId: request.grantRequestId, decision });
      onAnswered(request.grantRequestId);
    } catch (cause) {
      // Usually expired or already answered in another window; refresh the list.
      setError(bridgeErrorMessage(cause));
      onStale();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning-foreground">
            <ShieldQuestionIcon className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <DialogTitle>{t("Run a command on this computer?")}</DialogTitle>
            <DialogDescription>
              {t("An agent on {server} wants to run a command here.").replace(
                "{server}",
                serverLabel,
              )}
            </DialogDescription>
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
          <DetailRow label={t("Thread")}>
            {threadShell ? (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{threadShell.title}</span>
                {project ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{project.title}</span>
                ) : null}
              </span>
            ) : request.threadId ? (
              <span className="truncate font-mono text-xs">{request.threadId}</span>
            ) : (
              <span className="text-muted-foreground">{t("Not in a thread")}</span>
            )}
          </DetailRow>
          {agent || request.label ? (
            <DetailRow label={t("Agent")}>
              <span className="flex min-w-0 items-baseline gap-1.5">
                {agent ? <span className="shrink-0">{agent}</span> : null}
                {request.label ? (
                  <span className="truncate text-muted-foreground">{request.label}</span>
                ) : null}
              </span>
            </DetailRow>
          ) : null}
          <DetailRow label={t("Folder")}>
            <span className="block font-mono text-xs leading-5 break-all">{request.winCwd}</span>
          </DetailRow>
        </dl>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {request.mode === "powershell" ? t("PowerShell script") : t("Command")}
          </p>
          <pre className="max-h-52 overflow-auto rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
            {request.summary}
          </pre>
          {request.requestCount > 1 ? (
            <p className="text-xs text-muted-foreground">
              {t("{count} commands from this thread are waiting on this answer.").replace(
                "{count}",
                String(request.requestCount),
              )}
            </p>
          ) : null}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {request.threadId === null
            ? t("This request has no thread, so it can only be allowed once.")
            : request.strictMode
              ? t(
                  "Strict mode is on, so every command asks first. Denying also blocks this thread for 10 minutes.",
                )
              : t(
                  "Allowing for this thread skips this question until the thread is idle for 7 days. Denying also blocks this thread for 10 minutes.",
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
        <Button
          variant={canAllowThread ? "outline" : "default"}
          size="sm"
          disabled={busy !== null}
          onClick={() => void answer("allow-once")}
        >
          {t("Allow once")}
        </Button>
        {canAllowThread ? (
          <Button size="sm" disabled={busy !== null} onClick={() => void answer("allow-session")}>
            {t("Allow for this thread")}
          </Button>
        ) : null}
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
