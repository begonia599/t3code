import type { ApplicationDiagnostic } from "@t3tools/contracts";
import { useT } from "../../i18n";

export function ApplicationDiagnostics({ items }: { items: ReadonlyArray<ApplicationDiagnostic> }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <section className="space-y-3" aria-label={t("Deployment diagnostics")}>
      <h3 className="font-medium">{t("Deployment diagnostics")}</h3>
      {items.map((item) => (
        <div key={item.id} className="space-y-1 rounded border p-3 text-xs">
          <p>
            {t(item.phase)} {item.step !== undefined ? ` · ${t("Step")} ${item.step}` : ""}
            {item.commandExitCode !== undefined
              ? ` · ${t("Launcher exit")}: ${item.commandExitCode}`
              : ""}
            {item.cancelled ? ` · ${t("Timed out or cancelled.")}` : ""}
          </p>
          <p className="break-all">{item.unit}</p>
          <p>
            {item.capturedAt} · {t("Release")} {item.releaseId}
          </p>
          <p className="break-all">
            {Object.entries(item.state)
              .map(([key, value]) => `${key}=${value}`)
              .join(" · ")}
          </p>
          {!item.stateAvailable ? <p>{t("Systemd state unavailable.")}</p> : null}
          {item.journalStatus !== "available" ? (
            <p>
              {t(
                item.journalStatus === "empty"
                  ? "No journal entries were found for this attempt."
                  : "Journal could not be read.",
              )}
            </p>
          ) : null}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
            {[item.stdout, item.stderr, item.journal, item.collectionError]
              .filter(Boolean)
              .join("\n")}
          </pre>
          {item.truncated ? <p>{t("Log output was truncated.")}</p> : null}
        </div>
      ))}
    </section>
  );
}
