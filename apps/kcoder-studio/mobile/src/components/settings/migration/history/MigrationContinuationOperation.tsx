import { historicalControls } from "@/runtime/migration-history-controls";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import { makeStyles } from "../migration-result-ui";
import { Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useMigrationAction } from "../workbench/useMigrationAction";
import { useHistoricalWorker } from "./useHistoricalWorker";
import { MigrationContinuationUndo } from "./MigrationContinuationUndo";

export function MigrationContinuationOperation({ client, jobId, onOpenThread }: { client: MobileMigrationClient; jobId: string; onOpenThread?(id: string): void }) {
  const styles = useThemedStyles(makeStyles), task = useHistoricalWorker(client, "continuationRead", { jobId }), opening = useMigrationAction(client);
  const [confirm, setConfirm] = useState<"RUN" | "RESUME" | "CANCEL" | null>(null), [word, setWord] = useState("");
  const [undo, setUndo] = useState<{ loaded: boolean; stage?: string; workerRunning: boolean }>({ loaded: false, workerRunning: false });
  const latestUndo = useRef(undo); latestUndo.current = undo;
  const value = task.result, job = value?.job;
  const controls = historicalControls("continuation", job?.stage, job?.cancelRequested, value?.workerRunning);
  const choose = (mode: typeof confirm) => { setConfirm(mode); setWord(""); };
  async function operate() {
    const mode = confirm; if (!mode) return;
    const ok = await task.perform(async () => {
      const fresh = await client.call("continuationRead", { jobId });
      if (mode === "CANCEL") return client.call("continuationCancel", { jobId });
      if (fresh.workerRunning) throw new Error("continuation_worker_running");
      return client.call(mode === "RUN" ? "continuationRun" : "continuationResume", { jobId, expectedSequence: fresh.job.sequence });
    });
    if (ok) choose(null);
  }
  const canOpen = () => task.valid() && client.available() && (!client.supports("undoLookup") || latestUndo.current.loaded && !latestUndo.current.workerRunning && latestUndo.current.stage !== "undone");
  async function open() {
    await opening.run(async () => {
      if (!canOpen()) throw new Error("historical_undo_navigation_blocked");
      const fresh = await client.call("continuationRead", { jobId });
      if (fresh.job.stage !== "imported" || !fresh.job.threadId || fresh.workerRunning) throw new Error("continuation_not_imported");
      if (client.supports("undoLookup")) {
        const canonical = await client.call("undoLookup", { continuationJobId: jobId });
        if (canonical.existingJob) {
          const currentUndo = await client.call("undoRead", { jobId: canonical.existingJob.jobId });
          if (currentUndo.workerRunning || currentUndo.job.stage === "undone") throw new Error("historical_undo_navigation_blocked");
        }
      }
      const source = await client.call("continuationSource", { threadId: fresh.job.threadId });
      if (!canOpen() || source.source?.operationId !== jobId || source.source.sourceJobId !== fresh.job.sourceJobId || source.source.viewId !== fresh.job.viewId) throw new Error("continuation_source_changed");
      const final = await client.call("continuationRead", { jobId });
      if (!canOpen() || final.job.stage !== "imported" || final.job.threadId !== fresh.job.threadId) throw new Error("continuation_source_changed");
      if (client.supports("undoLookup")) {
        const finalUndo = await client.call("undoLookup", { continuationJobId: jobId });
        if (finalUndo.existingJob) {
          const status = await client.call("undoRead", { jobId: finalUndo.existingJob.jobId });
          if (status.workerRunning || status.job.stage === "undone") throw new Error("historical_undo_navigation_blocked");
        }
      }
      if (!canOpen()) throw new Error("migration_scope_changed");
      return fresh.job.threadId;
    }, threadId => { if (canOpen()) onOpenThread?.(threadId); });
  }
  return <SettingsGroup title={t("migration_history.continuation_record")} testID="migration-continuation-operation">
    <Text selectable style={styles.note}>{jobId}</Text>
    <Text style={styles.note}>{t("migration_history.continuation_idle_note")}</Text>
    <MigrationProblem code={task.error ?? opening.error ?? value?.workerError ?? job?.failureCode}/>
    {job ? <><Text style={styles.title}>{t(`migration_results.stage_${job.stage}`)}</Text><Text style={styles.note}>{t(value?.workerRunning ? "migration_results.worker_running" : "migration_workbench.worker_idle")}</Text>{job.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}<Text selectable style={styles.note}>{job.sourceJobId} · {job.viewId} · {job.options.studioWorkMode}</Text>{job.threadId ? <Text selectable style={styles.note}>{t("migration_results.result_session", { id: job.threadId })}</Text> : null}{job.options.localAttachments?.length ? <Text style={styles.warning}>{t("migration_history.bound_supplements", { count: job.options.localAttachments.length })}</Text> : null}{job.compilation ? <Text style={styles.note}>{t("migration_history.compilation", { count: job.compilation.entries, bytes: job.compilation.encodedBytes })}</Text> : null}{[...(job.compilation?.issues ?? []), ...(job.projection?.issues ?? [])].slice(0, 10).map((issue, index) => <Text key={index} style={styles.warning}>{issue.code}</Text>)}</> : null}
    <View style={styles.actions}><Button testID="migration-continuation-refresh" variant="ghost" onPress={task.refresh}>{t("migration_results.refresh")}</Button>{(["RUN", "RESUME", "CANCEL"] as const).map(mode => <Button key={mode} testID={`migration-continuation-${mode.toLowerCase()}`} disabled={!job || task.busy || !controls[mode === "RUN" ? "run" : mode === "RESUME" ? "resume" : "cancel"]} onPress={() => choose(mode)}>{t(mode === "RUN" ? "migration_history.publish_idle" : mode === "RESUME" ? "migration_workbench.resume" : "migration_workbench.cancel")}</Button>)}
      {onOpenThread ? <Button testID="migration-continuation-open" disabled={!job || job.stage !== "imported" || opening.busy || !canOpen() || !client.supports("continuationSource")} onPress={() => { void open(); }}>{t("migration_history.open_session")}</Button> : null}
    </View>
    {confirm ? <Confirm testID="migration-continuation-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void operate(); }} onDismiss={() => choose(null)} busy={task.busy}/> : null}
    {job?.stage === "imported" && client.supports("undoLookup") ? <MigrationContinuationUndo key={jobId} client={client} continuationJobId={jobId} onState={setUndo}/> : null}
  </SettingsGroup>;
}
