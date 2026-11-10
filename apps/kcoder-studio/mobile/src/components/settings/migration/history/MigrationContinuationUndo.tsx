import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { migrationRequestId, type MigrationCalls, type MobileMigrationClient } from "@/runtime/migration-client";
import { makeStyles } from "../migration-result-ui";
import { Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useMigrationAction } from "../workbench/useMigrationAction";
import { useHistoricalWorker } from "./useHistoricalWorker";

export function MigrationContinuationUndo({ client, continuationJobId, onState }: { client: MobileMigrationClient; continuationJobId: string; onState(value: { loaded: boolean; stage?: string; workerRunning: boolean }): void }) {
  const action = useMigrationAction(client), styles = useThemedStyles(makeStyles);
  const [operationId, setOperation] = useState<string | null>(null), [requestId, setRequest] = useState<string | null>(null);
  const [preview, setPreview] = useState<MigrationCalls["undoPreview"][1] | null>(null), [confirm, setConfirm] = useState<"UNDO" | "RUN" | "CANCEL" | null>(null), [word, setWord] = useState("");
  const [loaded, setLoaded] = useState(false);
  const task = useHistoricalWorker(client, "undoRead", { jobId: operationId ?? "" }, operationId !== null);
  const lookup = () => action.run(() => client.call("undoLookup", { continuationJobId }), value => { setLoaded(true); setOperation(value.existingJob?.jobId ?? null); setPreview(null); });
  useEffect(() => { void lookup(); }, [client, continuationJobId]);
  useEffect(() => { onState({ loaded: loaded && (!operationId || task.result !== null), stage: task.result?.job.stage, workerRunning: action.busy || task.busy || task.result?.workerRunning === true }); }, [loaded, operationId, task.result, task.busy, action.busy]);
  const choose = (mode: typeof confirm) => { setConfirm(mode); setWord(""); };
  async function operate() {
    if (!confirm) return;
    if (confirm === "UNDO") {
      const id = requestId ?? migrationRequestId(); setRequest(id);
      await action.run(async () => {
        const canonical = await client.call("undoLookup", { continuationJobId });
        if (canonical.existingJob) return canonical.existingJob;
        const freshPreview = await client.call("undoPreview", { continuationJobId });
        if (freshPreview.existingJob) return freshPreview.existingJob;
        if (!freshPreview.canUndo) throw new Error(freshPreview.reasonCode ?? "historical_undo_not_available");
        const continuation = await client.call("continuationRead", { jobId: continuationJobId });
        if (continuation.workerRunning || continuation.job.stage !== "imported") throw new Error("historical_undo_continuation_not_imported");
        return (await client.call("undoCreate", { requestId: id, continuationJobId, expectedContinuationSequence: continuation.job.sequence })).job;
      }, job => { setOperation(job.jobId); choose(null); setPreview(null); });
    } else if (operationId) {
      const mode = confirm;
      const ok = await task.perform(async () => {
        const fresh = await client.call("undoRead", { jobId: operationId });
        if (mode === "CANCEL") return client.call("undoCancel", { jobId: operationId });
        if (fresh.workerRunning) throw new Error("historical_undo_worker_running");
        return client.call("undoRun", { jobId: operationId, expectedSequence: fresh.job.sequence });
      });
      if (ok) choose(null);
    }
  }
  return <View style={styles.stack} testID="migration-continuation-undo">
    <Text style={styles.title}>{t("migration_history.retire_session")}</Text>
    <Text style={styles.note}>{t("migration_history.retire_note")}</Text>
    <MigrationProblem code={action.error ?? task.error ?? task.result?.workerError ?? task.result?.job.failureCode}/>
    <View style={styles.actions}><Button testID="migration-undo-lookup" variant="ghost" disabled={action.busy} onPress={() => { void lookup(); task.refresh(); }}>{t("migration_workbench.reconcile")}</Button><Button testID="migration-undo-preview" disabled={action.busy || !loaded || !!operationId} onPress={() => { void action.run(() => client.call("undoPreview", { continuationJobId }), value => { if (value.existingJob) setOperation(value.existingJob.jobId); setPreview(value); }); }}>{t("migration_history.check_retirement")}</Button></View>
    {preview ? <><Text style={styles.note}>{preview.reasonCode ?? t(preview.canUndo ? "migration_history.retirement_available" : "migration_history.retirement_unavailable")}</Text>{preview.canUndo && !preview.existingJob ? <Button testID="migration-undo-create" onPress={() => choose("UNDO")}>{t("migration_history.prepare_retirement")}</Button> : null}</> : null}
    {operationId ? <><Text selectable style={styles.note}>{operationId}</Text>{task.result ? <><Text style={styles.title}>{t(`migration_history.undo_${task.result.job.stage}`)}</Text><Text style={styles.note}>{t(task.result.workerRunning ? "migration_results.worker_running" : "migration_workbench.worker_idle")}</Text>{task.result.job.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}</> : null}<View style={styles.actions}><Button testID="migration-undo-run" disabled={!task.result || task.busy || task.result.workerRunning || task.result.job.stage === "undone" || task.result.job.stage === "conflict"} onPress={() => choose("RUN")}>{t("migration_history.run_retirement")}</Button><Button testID="migration-undo-cancel" variant="ghost" disabled={!task.result || task.busy || task.result.job.cancelRequested || ["undone", "conflict"].includes(task.result.job.stage)} onPress={() => choose("CANCEL")}>{t("migration_workbench.cancel")}</Button></View></> : null}
    {requestId ? <Text selectable style={styles.note}>{t("migration_history.original_operation", { id: requestId })}</Text> : null}
    {confirm ? <Confirm testID="migration-undo-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void operate(); }} onDismiss={() => choose(null)} busy={action.busy || task.busy}/> : null}
  </View>;
}
