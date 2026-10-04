import {
  ProviderInstanceExecution,
  supportsProviderSandbox,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useT } from "../../i18n";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isExecution = Schema.is(ProviderInstanceExecution);

export function ProviderExecutionSettings(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly readOnly: boolean;
  readonly onUpdate: (instance: ProviderInstanceConfig) => void;
}) {
  const t = useT();
  if (!supportsProviderSandbox(props.instance.driver)) return null;
  const execution = props.instance.execution;
  return (
    <SettingsSection title={t("Execution environment")} inert={props.readOnly}>
      <SettingsRow
        title={t("Linux sandbox")}
        description={t(
          "Use a host-provisioned profile with a separate system user and private provider configuration.",
        )}
      >
        <Switch
          aria-label={t("Linux sandbox")}
          checked={execution !== undefined}
          disabled={props.readOnly}
          onCheckedChange={(checked) => {
            if (checked) {
              props.onUpdate({
                ...props.instance,
                execution: { mode: "linux-sandbox", profile: props.instanceId },
              });
            } else {
              const { execution: _execution, ...instance } = props.instance;
              props.onUpdate(instance);
            }
          }}
        />
      </SettingsRow>
      {execution ? (
        <SettingsRow
          title={t("Sandbox profile")}
          description={t(
            "The host profile controls shared folders, tools and network routing. Provider environment values remain readable inside the sandbox.",
          )}
        >
          <div className="w-64">
            <DraftInput
              aria-label={t("Sandbox profile")}
              value={execution.profile}
              onCommit={(value) => {
                const next = { mode: "linux-sandbox", profile: value.trim() };
                if (isExecution(next)) {
                  props.onUpdate({ ...props.instance, execution: next });
                } else {
                  toastManager.add({
                    type: "error",
                    title: t("Invalid sandbox profile"),
                    description: t(
                      "Use a letter followed by letters, numbers, underscores or hyphens (up to 64 characters).",
                    ),
                  });
                }
              }}
              maxLength={64}
            />
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
