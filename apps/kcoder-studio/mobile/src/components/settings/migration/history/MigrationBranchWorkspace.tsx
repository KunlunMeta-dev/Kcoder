import { historicalControls } from "@/runtime/migration-history-controls";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import { PageControls, appendPage, makeStyles } from "../migration-result-ui";
import { Check, Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useHistoricalRead } from "./useHistoricalRead";
import { useHistoricalWorker } from "./useHistoricalWorker";
import { MigrationBranchRecords } from "./MigrationBranchRecords";
import { MigrationBranchTools } from "./MigrationBranchTools";
import type { HistoricalLocalAttachmentBinding } from "../../../../../../shared/generated/contracts";
import { samePublicValue } from "@/runtime/migration-client/history-validation";
import { MigrationContinuationWorkspace } from "./MigrationContinuationWorkspace";
import { MigrationHistorySearch } from "./MigrationHistorySearch";
import { useMigrationHistoryView } from './useMigrationHistoryView';
import { MigrationHistoryViewStatus } from './MigrationHistoryViewStatus';

export function MigrationBranchWorkspace({ client, jobId, onOpenThread }: { client: MobileMigrationClient; jobId: string; onOpenThread?(id: string): void }) {
  const styles = useThemedStyles(makeStyles), task = useHistoricalWorker(client, "branchRead", { jobId });
  const history = useHistoricalRead(client, "historyRead", { jobId });
  const [pages, setPages] = useState<Array<string | null>>([null]);
  const [related, setRelated] = useState<string[]>([]), [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState<"PREPARE" | "RUN" | "RESUME" | "CANCEL" | null>(null), [word, setWord] = useState("");
  const [tab, setTab] = useState<"records" | "tools">("records");
  const [bindings, setBindings] = useState<HistoricalLocalAttachmentBinding[]>([]);
  const relatedPage = useHistoricalRead(client, "historyJobs", { cursor: pages.at(-1) }, edit && history.result?.job.source === "codex");
  const state = task.result, viewId = state?.choice?.viewId, progress = state?.progress;
  const protection=useMigrationHistoryView(client,jobId,progress?.stage==='ready'?history.result?.job.archiveId:undefined,viewId);
  const controls = historicalControls("branch", progress?.stage, progress?.cancelRequested, state?.workerRunning);
  const choose = (value: typeof confirm) => { setConfirm(value); setWord(""); };
  async function operate() {
    const operation = confirm;
    if (!operation) return;
    const success = await task.perform(async () => {
      if (operation === "PREPARE") return client.call("branchPrepare", { jobId, relatedJobIds: related });
      if (!viewId) throw new Error("history_branch_selection_required");
      const fresh = await client.call("branchRead", { jobId, viewId });
      if (fresh.choice?.viewId !== viewId) throw new Error("history_branch_selection_changed");
      if (operation === "CANCEL") { await client.call("branchCancel", { jobId, viewId }); return client.call("branchRead", { jobId, viewId }); }
      if (fresh.workerRunning) throw new Error("history_worker_running");
      if (operation === "RUN") return client.call("branchRun", { jobId, viewId });
      if (!fresh.progress) throw new Error("history_branch_progress_unavailable");
      return client.call("branchResume", { jobId, viewId, expectedSequence: fresh.progress.sequence });
    });
    if (success) { setConfirm(null); setEdit(false); }
  }
  return <View style={styles.stack} testID="migration-branch-workspace">
    <SettingsGroup title={t("migration_history.branch")}>
      <MigrationProblem code={task.error ?? state?.workerError ?? progress?.failureCode}/>
      <Text style={styles.note}>{t("migration_history.branch_note")}</Text>
      {viewId ? <Text selectable style={styles.note}>{viewId}</Text> : null}
      {state?.choice ? <Text selectable style={styles.note}>{t("migration_history.related_count", { count: state.choice.relatedJobIds.length })}</Text> : null}
      {progress ? <><Text style={styles.title}>{t(`migration_history.branch_${progress.stage}`)}</Text><Text style={styles.note}>{progress.writtenItems} / {progress.totalItems ?? t("migration_history.unknown")}</Text>{progress.structuralComplete === false && !progress.issues.includes("codex_readable_reconstruction_requires_admission") ? <Text style={styles.warning}>{t("migration_history.incomplete_branch")}</Text> : null}{progress.issues.map(code => <Text key={code} style={styles.warning}>{code === "codex_readable_reconstruction_requires_admission" ? t("migration_history.reconstructed_branch") : code}</Text>)}</> : null}
      <Text style={styles.note}>{t(state?.workerRunning ? "migration_results.worker_running" : "migration_workbench.worker_idle")}</Text>
      {progress?.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
      <View style={styles.actions}>
        <Button testID="migration-branch-refresh" variant="ghost" onPress={task.refresh}>{t("migration_results.refresh")}</Button>
        <Button testID="migration-branch-choose" disabled={task.busy || state?.workerRunning} onPress={() => { setRelated([]); setEdit(true); }}>{t("migration_history.choose_branch")}</Button>
        <Button testID="migration-branch-run" disabled={!viewId || task.busy || !controls.run} onPress={() => choose("RUN")}>{t("migration_history.build_branch")}</Button>
        <Button testID="migration-branch-resume" disabled={!viewId || task.busy || !controls.resume} onPress={() => choose("RESUME")}>{t("migration_workbench.resume")}</Button>
        <Button testID="migration-branch-cancel" disabled={!viewId || task.busy || !controls.cancel} onPress={() => choose("CANCEL")}>{t("migration_workbench.cancel")}</Button>
      </View>
      {edit ? <View testID="migration-branch-choice" style={styles.stack}>
        <Text style={styles.note}>{t("migration_history.related_note")}</Text>
        <MigrationProblem code={relatedPage.error}/>
        {relatedPage.result?.jobs.filter(row => row.job.jobId !== jobId && row.job.source === "codex" && row.job.stage === "normalized").map(row => <Check key={row.job.jobId} testID={`migration-related-${row.job.jobId}`} checked={related.includes(row.job.jobId)} disabled={!related.includes(row.job.jobId) && related.length >= 63} label={row.job.jobId} onPress={() => setRelated(old => old.includes(row.job.jobId) ? old.filter(id => id !== row.job.jobId) : [...old, row.job.jobId])}/>)}
        {history.result?.job.source === "codex" ? <PageControls previous={pages.length > 1} next={!!relatedPage.result?.nextCursor} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = relatedPage.result?.nextCursor; if (next) setPages(old => appendPage(old, next)); }}/> : null}
        <Text style={styles.note}>{t("migration_history.related_count", { count: related.length })}</Text>
        <Button testID="migration-branch-prepare" disabled={task.busy} onPress={() => choose("PREPARE")}>{t("migration_history.prepare_branch")}</Button>
        <Button variant="ghost" onPress={() => setEdit(false)}>{t("migration_workbench.dismiss")}</Button>
      </View> : null}
      {confirm ? <Confirm testID="migration-branch-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void operate(); }} onDismiss={() => choose(null)} busy={task.busy}/> : null}
    </SettingsGroup>
    {viewId && progress?.stage === "ready" ? <View key={viewId} style={styles.stack}>
      <MigrationHistoryViewStatus model={protection}/>
      <MigrationHistorySearch client={client} jobId={jobId} viewId={viewId}/>
      <View style={styles.actions}><Button testID="migration-branch-records-tab" variant={tab === "records" ? "secondary" : "ghost"} onPress={() => setTab("records")}>{t("migration_results.records")}</Button><Button testID="migration-branch-tools-tab" disabled={!client.supports("toolsRead")} variant={tab === "tools" ? "secondary" : "ghost"} onPress={() => setTab("tools")}>{t("migration_history.tools")}</Button></View>
      {tab === "records" ? <MigrationBranchRecords client={client} jobId={jobId} viewId={viewId} bindings={bindings.filter(item => item.selection.viewId === viewId)} onBinding={(binding, selected) => setBindings(old => selected ? [...old.filter(item => !samePublicValue(item.selection, binding.selection)), binding] : old.filter(item => !samePublicValue(item, binding)))}/> : <MigrationBranchTools client={client} jobId={jobId} viewId={viewId}/>}
      {client.supports("continuationCreate") ? <MigrationContinuationWorkspace client={client} sourceJobId={jobId} viewId={viewId} bindings={bindings.filter(item => item.selection.viewId === viewId)} onOpenThread={onOpenThread}/> : null}
    </View> : null}
  </View>;
}
