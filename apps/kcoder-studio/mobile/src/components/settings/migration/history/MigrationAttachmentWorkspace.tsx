import { historicalControls } from "@/runtime/migration-history-controls";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import type { HistoricalAttachmentSelection, HistoricalLocalAttachmentBinding } from "../../../../../../shared/generated/contracts";
import { chooseMigrationDownload } from "@/runtime/migration-local-files";
import { receiveMigrationAttachment } from "@/runtime/migration-local-transfer";
import { useMigrationAction } from "../workbench/useMigrationAction";
import { MigrationLocalSupplement } from "./MigrationLocalSupplement";
import { PageControls, appendPage, makeStyles } from "../migration-result-ui";
import { Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useHistoricalRead } from "./useHistoricalRead";
import { useHistoricalWorker } from "./useHistoricalWorker";

export function MigrationAttachmentWorkspace({ client, selection, nested = false, bindings, onBinding }: { client: MobileMigrationClient; selection: HistoricalAttachmentSelection; nested?: boolean; bindings: HistoricalLocalAttachmentBinding[]; onBinding(binding: HistoricalLocalAttachmentBinding, selected: boolean): void }) {
  const styles = useThemedStyles(makeStyles);
  const download = useMigrationAction(client);
  const task = useHistoricalWorker(client, nested ? "toolAttachmentRead" : "attachmentRead", { selection });
  const [pages, setPages] = useState([0]), [item, setItem] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"RUN" | "RESUME" | "CANCEL" | null>(null), [word, setWord] = useState("");
  const value = task.result, job = value?.job;
  const controls = historicalControls("attachment", job?.stage, job?.cancelRequested, value?.workerRunning);
  const catalog = useHistoricalRead(client, "toolAttachmentItems", { selection, cursor: pages.at(-1) }, nested && selection.toolItemIndex == null && job?.stage === "catalogued");
  async function operate() {
    const mode = confirm; if (!mode) return;
    const ok = await task.perform(async () => {
      const fresh = await client.call(nested ? "toolAttachmentRead" : "attachmentRead", { selection });
      if (mode === "CANCEL") return client.call(nested ? "toolAttachmentCancel" : "attachmentCancel", { selection });
      if (fresh.workerRunning) throw new Error("history_worker_running");
      if (mode === "RUN") return client.call(nested ? "toolAttachmentRun" : "attachmentRun", { selection });
      if (!fresh.job) throw new Error("history_attachment_job_required");
      return client.call(nested ? "toolAttachmentResume" : "attachmentResume", { selection, expectedSequence: fresh.job.sequence });
    });
    if (ok) setConfirm(null);
  }
  if (item !== null) return <View style={styles.stack}><Button variant="ghost" onPress={() => setItem(null)}>{t("migration_history.back_to_attachment_items")}</Button><MigrationAttachmentWorkspace key={item} client={client} selection={{ ...selection, toolItemIndex: item }} nested bindings={bindings} onBinding={onBinding}/></View>;
  return <SettingsGroup title={t(nested ? "migration_history.tool_attachments" : "migration_history.attachment")} testID="migration-attachment-workspace">
    <Text style={styles.note}>{t("migration_history.attachment_note")}</Text>
    <MigrationProblem code={task.error ?? value?.workerError ?? job?.failureCode ?? catalog.error ?? download.error}/>
    {job ? <><Text style={styles.title}>{t(`migration_history.attachment_${job.stage}`)}</Text><Text style={styles.note}>{job.processedBytes} {t("migration_history.bytes")}</Text></> : null}
    {job?.info ? <><Text style={styles.note}>{t(`migration_history.attachment_kind_${job.info.kind}`)}</Text>{job.info.mediaType ? <Text style={styles.note}>{job.info.mediaType}</Text> : null}{job.info.issue ? <Text style={styles.warning}>{job.info.issue}</Text> : null}{job.info.receipt ? <Text selectable style={styles.note}>{job.info.receipt.bytes} {t("migration_history.bytes")} · SHA-256 {job.info.receipt.sha256}</Text> : null}</> : null}
    <Text style={styles.note}>{t(value?.workerRunning ? "migration_results.worker_running" : "migration_workbench.worker_idle")}</Text>
    {job?.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
    <View style={styles.actions}>
      <Button testID="migration-attachment-refresh" variant="ghost" onPress={task.refresh}>{t("migration_results.refresh")}</Button>
      {(["RUN", "RESUME", "CANCEL"] as const).map(mode => <Button key={mode} testID={`migration-attachment-${mode.toLowerCase()}`} disabled={task.busy || !controls[mode === "RUN" ? "run" : mode === "RESUME" ? "resume" : "cancel"]} onPress={() => { setWord(""); setConfirm(mode); }}>{t(mode === "RUN" ? "migration_history.inspect_attachment" : mode === "RESUME" ? "migration_workbench.resume" : "migration_workbench.cancel")}</Button>)}
    </View>
    {confirm ? <Confirm testID="migration-attachment-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void operate(); }} onDismiss={() => setConfirm(null)} busy={task.busy}/> : null}
    {job?.info?.receipt && job.stage === "ready" ? <Button testID="migration-attachment-download" disabled={download.busy} onPress={() => { const receipt = job.info?.receipt; if (!receipt) return; void download.run(async () => { const sink = await chooseMigrationDownload(receipt.bytes, receipt.attachmentId); if (!sink) return; await receiveMigrationAttachment(client, selection, receipt, sink, () => { if (!task.valid()) throw new Error("migration_scope_changed"); }); }); }}>{t("migration_history.download_verified")}</Button> : null}
    {job?.catalog ? <Text style={styles.note}>{t("migration_history.attachment_catalog", { attachments: job.catalog.attachments, unknown: job.catalog.unknownItems, opaque: job.catalog.opaqueItems })}</Text> : null}
    {catalog.result?.items.map(row => <Button key={row.index} testID={`migration-tool-attachment-${row.index}`} variant="ghost" onPress={() => setItem(row.index)}>{`${row.index + 1} · ${row.sourceType}`}</Button>)}
    {catalog.result ? <PageControls previous={pages.length > 1} next={catalog.result.nextCursor != null} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = catalog.result?.nextCursor; if (next != null) setPages(old => appendPage(old, next)); }}/> : null}
    {job?.info?.kind === "local_reference" && client.supports("localPrepare") ? <MigrationLocalSupplement client={client} selection={selection} bindings={bindings} onBinding={onBinding}/> : null}
  </SettingsGroup>;
}
