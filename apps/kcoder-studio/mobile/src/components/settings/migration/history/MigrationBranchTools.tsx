import { historicalControls } from "@/runtime/migration-history-controls";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import { PageControls, appendPage, makeStyles } from "../migration-result-ui";
import { Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useHistoricalRead } from "./useHistoricalRead";
import { useHistoricalWorker } from "./useHistoricalWorker";

export function MigrationBranchTools({ client, jobId, viewId }: { client: MobileMigrationClient; jobId: string; viewId: string }) {
  const styles = useThemedStyles(makeStyles), task = useHistoricalWorker(client, "toolsRead", { jobId, viewId });
  const [pages, setPages] = useState<Array<string | null>>([null]), [confirm, setConfirm] = useState<"RUN" | "RESUME" | "CANCEL" | null>(null), [word, setWord] = useState("");
  const state = task.result?.state;
  const controls = historicalControls("tools", state?.run?.stage, state?.cancelRequested, state?.workerRunning);
  const page = useHistoricalRead(client, "toolsPage", { jobId, viewId, cursor: pages.at(-1) }, state?.progress?.sealed === true, state?.run?.sequence);
  async function operate() {
    const mode = confirm;
    if (!mode) return;
    const ok = await task.perform(async () => {
      const fresh = await client.call("toolsRead", { jobId, viewId });
      if (mode === "CANCEL") return client.call("toolsCancel", { jobId, viewId });
      if (fresh.state.workerRunning) throw new Error("history_worker_running");
      if (mode === "RUN") return client.call("toolsRun", { jobId, viewId });
      if (!fresh.state.run) throw new Error("history_tool_progress_unavailable");
      return client.call("toolsResume", { jobId, viewId, expectedSequence: fresh.state.run.sequence });
    });
    if (ok) setConfirm(null);
  }
  return <SettingsGroup title={t("migration_history.tools")} testID="migration-branch-tools">
    <Text style={styles.note}>{t("migration_history.tools_note")}</Text>
    <MigrationProblem code={task.error ?? task.result?.workerError ?? state?.run?.failureCode ?? page.error}/>
    {state?.run ? <Text style={styles.title}>{t(`migration_history.tools_${state.run.stage}`)}</Text> : null}
    {state?.progress ? <Text style={styles.note}>{t("migration_history.tool_progress", { records: state.progress.processedRecords, links: state.progress.recordedLinks, unresolved: state.progress.unresolvedLinks })}</Text> : null}
    <Text style={styles.note}>{t(state?.workerRunning ? "migration_results.worker_running" : "migration_workbench.worker_idle")}</Text>
    {state?.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
    <View style={styles.actions}>
      <Button variant="ghost" onPress={task.refresh}>{t("migration_results.refresh")}</Button>
      {(["RUN", "RESUME", "CANCEL"] as const).map(mode => <Button key={mode} testID={`migration-tools-${mode.toLowerCase()}`} disabled={task.busy || !controls[mode === "RUN" ? "run" : mode === "RESUME" ? "resume" : "cancel"]} onPress={() => { setWord(""); setConfirm(mode); }}>{t(mode === "RUN" ? "migration_history.correlate" : mode === "RESUME" ? "migration_workbench.resume" : "migration_workbench.cancel")}</Button>)}
    </View>
    {confirm ? <Confirm testID="migration-tools-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void operate(); }} onDismiss={() => setConfirm(null)} busy={task.busy}/> : null}
    {page.result?.links.map(link => <View key={link.id} style={styles.row}><Text selectable style={styles.title}>{link.name ?? link.callId}</Text><Text selectable style={styles.note}>{link.callId}</Text><Text style={styles.note}>{t(`migration_history.link_${link.status}`)} · {t(`migration_results.outcome_${link.outcome}`)}</Text>{link.call ? <Text style={styles.note}>{t("migration_history.call_position", { position: link.call.sequence + 1, block: link.call.block ?? t("migration_history.unknown") })}</Text> : null}{link.result ? <Text style={styles.note}>{t("migration_history.result_position", { position: link.result.sequence + 1, block: link.result.block ?? t("migration_history.unknown") })}</Text> : null}</View>)}
    {state?.progress?.sealed ? <PageControls previous={pages.length > 1} next={!!page.result?.nextCursor} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = page.result?.nextCursor; if (next) setPages(old => appendPage(old, next)); }}/> : null}
  </SettingsGroup>;
}
