import { useAtomValue } from "@effect/atom-react";
import {
  ApprovalRequestId,
  type CredentialInputRequest,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/unstable/reactivity";
import { useId, useState } from "react";
import { useResourceMutation } from "../../hooks/useResourceMutation";
import { useT } from "../../i18n";
import { resources } from "../../state/resources";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

/** The usual question card with an answer kept only in this component's memory. */
export function CredentialInputRequestPanel({
  environmentId,
  request,
  onAnswered,
}: {
  environmentId: EnvironmentId;
  request: CredentialInputRequest;
  onAnswered?: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState("");
  const { mutate, busy, error } = useResourceMutation(
    environmentId,
    "Could not submit private input. Please try again.",
  );
  const canSubmit = value.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    if (
      await mutate({
        type: "write",
        payload: {
          requestId: request.id,
          name: request.name,
          description: request.description,
          valueType: request.valueType,
          ...(request.usage ? { usage: request.usage } : {}),
          allowedInstances: [request.instanceId],
          value: Redacted.make(value),
        },
      })
    ) {
      setValue("");
      onAnswered?.();
    }
  }

  async function dismiss() {
    if (await mutate({ type: "action", payload: { action: "dismiss", id: request.id } })) {
      setValue("");
      onAnswered?.();
    }
  }

  return (
    <div
      data-credential-input-request={request.id}
      onPaste={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Enter in this answer must never submit the enclosing chat form.
        event.stopPropagation();
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          if (!event.nativeEvent.isComposing) void submit();
        }
      }}
    >
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: ApprovalRequestId.make(request.id),
            createdAt: new Date(request.createdAt).toISOString(),
            questions: [
              {
                id: request.id,
                header: request.name,
                question: request.purpose,
                options: [],
                multiSelect: false,
              },
            ],
            dismissible: true,
          },
        ]}
        respondingRequestIds={busy ? [ApprovalRequestId.make(request.id)] : []}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => void submit()}
        onDismiss={() => void dismiss()}
      >
        <div className="flex min-w-0 flex-col gap-2 pe-2 pb-2">
          {request.description && request.description !== request.purpose ? (
            <p className="text-xs text-muted-foreground wrap-anywhere">{request.description}</p>
          ) : null}
          <label htmlFor={inputId} className="sr-only">
            {t("Private value")}
          </label>
          {request.valueType === "text" ? (
            <Textarea
              id={inputId}
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={hintId}
              rows={3}
              size="sm"
            />
          ) : (
            <Input
              id={inputId}
              type="password"
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              aria-describedby={hintId}
              placeholder={t("Private value")}
            />
          )}
          <p id={hintId} className="text-xs text-muted-foreground">
            {t("This value is saved directly to the vault and is not sent as a chat message.")}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {t(error)}
            </p>
          ) : null}
          <ComposerPrimaryActions
            compact
            pendingAction={{
              questionIndex: 0,
              isLastQuestion: true,
              canAdvance: canSubmit,
              isComplete: canSubmit,
              isResponding: busy,
            }}
            isRunning={false}
            showPlanFollowUpPrompt={false}
            promptHasText={false}
            isSendBusy={busy}
            sendDisabledReason={null}
            isConnecting={false}
            isEnvironmentUnavailable={false}
            isPreparingWorktree={false}
            hasSendableContent={false}
            onPreviousPendingQuestion={() => {}}
            onSubmitPendingAction={() => void submit()}
            onInterrupt={() => {}}
            onImplementPlanInNewThread={() => {}}
          />
        </div>
      </ComposerPendingUserInputPanel>
    </div>
  );
}

export function ComposerPendingCredentialInputPanel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const state = useAtomValue(
    resources.snapshot({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(state));
  const request = snapshot?.vault.requests.find((request) => request.threadId === props.threadId);
  if (!request) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant="info">
        <CredentialInputRequestPanel
          key={request.id}
          environmentId={props.environmentId}
          request={request}
        />
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
