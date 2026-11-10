import { MigrationHistoryResourceBudgetPanel } from './MigrationHistoryResourceBudgetPanel';
import { historicalControls } from "@/runtime/migration-history-controls";
import { HISTORY_WORKER_STATE_CAPABILITY, historyWorkerObservation, historyWorkerMessage, isUntrackedHistory, canRecoverUntrackedHistory } from "@/runtime/migration-history-worker";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import type { MigrationResultsReader } from "@/runtime/migration-results";
import { MigrationHistoryRecords } from "../MigrationHistoryRecords";
import { makeStyles } from "../migration-result-ui";
import { Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useHistoricalWorker } from "./useHistoricalWorker";
import { MigrationReinterpretation } from "./MigrationReinterpretation";
import { MigrationBranchWorkspace } from "./MigrationBranchWorkspace";
import { MigrationHistorySearch } from "./MigrationHistorySearch";
import { useMigrationHistoryView } from './useMigrationHistoryView';
import { MigrationHistoryViewStatus } from './MigrationHistoryViewStatus';
import { MigrationArchiveRetirement } from './MigrationArchiveRetirement';

export function MigrationHistoryWorkspace({ client, reader, jobId, onHistory, onOpenThread }: { client: MobileMigrationClient; reader: MigrationResultsReader; jobId: string; onHistory(id: string): void; onOpenThread?(id: string): void }) {
  const styles = useThemedStyles(makeStyles);
  const task = useHistoricalWorker(client, "historyRead", { jobId });
  const [mode, setMode] = useState<"archive" | "branch">("archive");
  const [confirm, setConfirm] = useState<"RUN" | "RESUME" | "CANCEL" | null>(null);
  const [word, setWord] = useState("");
  const value = task.result, job = value?.job;
  const protection=useMigrationHistoryView(client,jobId,job?.archived?job.archiveId:undefined);
  const [retired,setRetired]=useState(false);
  const workerState = historyWorkerObservation(value, client.supportsCapability(HISTORY_WORKER_STATE_CAPABILITY));
  const recoverUntracked = canRecoverUntrackedHistory(value);
  const untracked = isUntrackedHistory(value);
  const stoppedStage = ["normalized", "failed", "cancelled"].includes(job?.stage ?? "");
  const controls = historicalControls("history", job?.stage, job?.cancelRequested, value?.workerRunning, job?.failureCode, workerState, untracked);
  async function execute() {
    const operation = confirm;
    if (!operation) return;
    await task.perform(async () => {
      const fresh = await client.call("historyRead", { jobId });
      const ownership = historyWorkerObservation(fresh, client.supportsCapability(HISTORY_WORKER_STATE_CAPABILITY));
      const permitted = historicalControls("history", fresh.job.stage, fresh.job.cancelRequested, fresh.workerRunning, fresh.job.failureCode, ownership, isUntrackedHistory(fresh));
      if (operation === "CANCEL") {
        if (!permitted.cancel) throw new Error("history_control_unavailable");
        return client.call("historyCancel", { jobId });
      }
      if (ownership === "unknown" && !(operation === "RESUME" && canRecoverUntrackedHistory(fresh))) throw new Error("history_worker_state_unknown");
      if (ownership === "running") throw new Error("history_worker_running");
      if (!(operation === "RUN" ? permitted.run : permitted.resume)) throw new Error("history_control_unavailable");
      return client.call(operation === "RUN" ? "historyRun" : "historyResume", { jobId, expectedSequence: fresh.job.sequence });
    });
    if (task.valid()) setConfirm(null);
  }
  return <View style={styles.stack} testID="migration-history-workspace">
    <SettingsGroup title={t("migration_history.archive_status")}>
      <Text selectable style={styles.note}>{jobId}</Text>
      <MigrationProblem code={task.error ?? value?.workerError ?? job?.failureCode}/>
      {job ? <>
        <Text style={styles.title}>{t(`migration_results.stage_${job.stage}`)}</Text>
        <Text testID="migration-history-worker-state" style={workerState === "unknown" ? styles.warning : styles.note}>{t(historyWorkerMessage(workerState))}</Text>
        {untracked ? <Text style={styles.warning}>{t(job.stage === "normalized" ? "migration_history.legacy_normalized_note" : stoppedStage ? "migration_history.legacy_terminal_note" : recoverUntracked ? "migration_history.legacy_recovery_note" : "migration_history.legacy_cancel_note")}</Text> : null}
        {job.cancelRequested && job.stage !== "cancelled" ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
        {job.normalization ? <Text style={styles.note}>{t("migration_history.normalized", { count: job.normalization.normalizedRecords, total: job.normalization.sourceRecords })}</Text> : null}
        {value?.progress ? <Text style={styles.note}>{t(`migration_history.phase_${value.progress.phase}`)} · {value.progress.processed}/{value.progress.total} {t(`migration_history.unit_${value.progress.unit}`)}</Text> : null}
      </> : null}
      <View style={styles.actions}>
        <Button testID="migration-history-refresh" variant="ghost" onPress={task.refresh}>{t("migration_results.refresh")}</Button>
        <Button testID="migration-history-run" disabled={!job || task.busy || !controls.run} onPress={() => { setWord(""); setConfirm("RUN"); }}>{t("migration_history.run_archive")}</Button>
        <Button testID="migration-history-resume" disabled={!job || task.busy || !controls.resume} onPress={() => { setWord(""); setConfirm("RESUME"); }}>{t(recoverUntracked ? job?.stage === "normalized" ? "migration_history.check_legacy_completed" : stoppedStage ? "migration_history.check_legacy_stopped" : "migration_history.recover_legacy" : "migration_history.resume_control")}</Button>
        <Button testID="migration-history-cancel" disabled={!job || task.busy || !controls.cancel} onPress={() => { setWord(""); setConfirm("CANCEL"); }}>{t(untracked && !stoppedStage ? "migration_history.cancel_before_legacy_recovery" : "migration_workbench.cancel")}</Button>
      </View>
      {confirm ? <Confirm testID="migration-history-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void execute(); }} onDismiss={() => setConfirm(null)} busy={task.busy}/> : null}
    </SettingsGroup>
    <MigrationHistoryResourceBudgetPanel client={client} jobId={jobId} cancelled={Boolean(job?.cancelRequested || job?.stage === "cancelled")}/>
    {!retired?<MigrationHistoryViewStatus model={protection}/>:null}
    {job?.archived?<MigrationArchiveRetirement client={client} jobId={jobId} releaseView={protection.release} onRetired={setRetired}/>:null}
    {retired?<Text style={styles.note} testID="migration-history-retired">{t('migration_history.lifecycle.retired_body')}</Text>:<>
    {job?.archived && client.supports("reinterpretPreview") ? <MigrationReinterpretation client={client} sourceJobId={jobId} onCreated={onHistory}/> : null}
    {job?.stage === "normalized" ? <>
      <View style={styles.actions}><Button testID="migration-history-archive-tab" variant={mode === "archive" ? "secondary" : "ghost"} onPress={() => setMode("archive")}>{t("migration_history.original_records")}</Button><Button testID="migration-history-branch-tab" disabled={!client.supports("branchRead")} variant={mode === "branch" ? "secondary" : "ghost"} onPress={() => setMode("branch")}>{t("migration_history.branch")}</Button></View>
      {mode === "archive" ? <><MigrationHistorySearch key={jobId} client={client} jobId={jobId}/><MigrationHistoryRecords reader={reader} jobId={jobId}/></> : <MigrationBranchWorkspace client={client} jobId={jobId} onOpenThread={onOpenThread}/>}
    </> : null}
    </>}
  </View>;
}
