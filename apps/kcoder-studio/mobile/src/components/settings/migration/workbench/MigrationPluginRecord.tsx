import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { migrationError, type MobileMigrationClient, type MigrationPluginStateResult, type MigrationBatchPluginSource } from "@/runtime/migration-client";
import { makeStyles } from "../migration-result-ui";
import { useMigrationAction } from "./useMigrationAction";
import { Confirm, MigrationProblem } from "./WorkbenchUi";

export function MigrationPluginRecord({ client, operationId, onUse, onBatch }: { client: MobileMigrationClient; operationId: string; onUse(binding: MigrationBatchPluginSource): void; onBatch(jobId: string): void }) {
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const [state, setState] = useState<MigrationPluginStateResult | null>(null);
  const latest = useRef(state); latest.current = state;
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<"COPY" | "RESUME" | "CANCEL" | "UNDO" | null>(null);
  const [word, setWord] = useState("");
  const [pollError, setPollError] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const ticket = epoch.current;
    let busyRetries = 0;
    async function observe() {
      try {
        const value = await client.call("pluginRead", { operationId });
        if (!active || !client.available() || ticket !== epoch.current) return;
        if (!latest.current || value.job.sequence >= latest.current.job.sequence) { latest.current = value; setState(value); }
        setPollError(null); busyRetries = 0;
        if (latest.current?.workerRunning) timer = setTimeout(() => { void observe(); }, 600);
      } catch (error) {
        if (!active || !client.available() || ticket !== epoch.current) return;
        const code = migrationError(error);
        if (["plugin_migration_busy", "migration_busy"].includes(code) && busyRetries++ < 8) timer = setTimeout(() => { void observe(); }, 250);
        else setPollError(code);
      }
    }
    void observe();
    return () => { active = false; clearTimeout(timer); };
  }, [client, operationId, revision]);
  const job = state?.job;
  const change = (value: typeof confirm) => { setWord(""); setConfirm(value); };
  async function execute() {
    const snapshot = latest.current;
    if (!snapshot || !confirm) return;
    const method = { COPY: "pluginCapture", RESUME: "pluginResume", CANCEL: "pluginCancel", UNDO: "pluginUndo" }[confirm] as "pluginCapture" | "pluginResume" | "pluginCancel" | "pluginUndo";
    epoch.current++;
    await action.run(() => client.operatePlugin(operationId, method), value => { latest.current = value; setState(value); setConfirm(null); });
    if (client.available()) setRevision(v => v + 1);
  }
  return <View style={styles.stack} testID="migration-plugin-record">
    <Text selectable style={styles.note}>{operationId}</Text>
    <Text style={styles.note}>{t("migration_workbench.plugin_static_note")}</Text>
    <Button testID="migration-plugin-refresh" variant="ghost" onPress={() => setRevision(v => v + 1)}>{t("migration_results.refresh")}</Button>
    <MigrationProblem code={action.error ?? pollError ?? state?.workerError ?? job?.failureCode}/>
    {job ? <>
      <Text style={styles.title}>{job.name} · {job.stage}</Text>
      {state?.workerRunning ? <Text style={styles.note}>{t("migration_results.worker_running")}</Text> : null}
      {job.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
      <Text selectable style={styles.note}>{t("migration_workbench.plugin_details", { files: job.packageFiles ?? "?", bytes: job.packageBytes ?? "?", capabilities: job.capabilities.join(", ") || "—" })}</Text>
      {[...job.pending, ...job.readiness].map((code, index) => <Text key={`${index}:${code}`} style={styles.warning}>{code}</Text>)}
      {job.batchJobId ? <Button testID="migration-plugin-parent" onPress={() => onBatch(job.batchJobId!)}>{t("migration_workbench.open_parent")}</Button> : <>
        {job.stage === "ready" && !job.cancelRequested && !state?.workerRunning ? <Button testID="migration-plugin-use" disabled={!client.supportsCapability("migrationBatchPluginsV1")} onPress={() => onUse({ operationId, expectedSequence: job.sequence })}>{t("migration_workbench.use_copy")}</Button> : null}
        {!job.imported ? <View style={styles.actions}>
          <Button testID="migration-plugin-copy" disabled={action.busy || state?.workerRunning || job.cancelRequested} onPress={() => change("COPY")}>{t("migration_workbench.copy")}</Button>
          <Button testID="migration-plugin-resume" disabled={action.busy || state?.workerRunning || !job.cancelRequested} onPress={() => change("RESUME")}>{t("migration_workbench.resume")}</Button>
          <Button testID="migration-plugin-cancel" disabled={action.busy || job.cancelRequested} onPress={() => change("CANCEL")}>{t("migration_workbench.cancel")}</Button>
        </View> : job.stage !== "undone" ? <Button testID="migration-plugin-undo" disabled={action.busy || state?.workerRunning} onPress={() => change("UNDO")}>{t("migration_workbench.undo")}</Button> : null}
      </>}
    </> : null}
    {confirm ? <Confirm testID="migration-plugin-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void execute(); }} onDismiss={() => change(null)} busy={action.busy}/> : null}
  </View>;
}
