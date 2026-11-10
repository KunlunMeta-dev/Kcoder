import { MigrationUploadCollectionPanel } from './MigrationUploadCollection';
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { migrationError, migrationRequestId, type MobileMigrationClient } from "@/runtime/migration-client";
import type { HistoricalAttachmentSelection, HistoricalLocalAttachmentBinding } from "../../../../../../shared/generated/contracts";
import { chooseMigrationDownload, chooseMigrationLocalFile } from "@/runtime/migration-local-files";
import { receiveMigrationAttachment, sendMigrationLocalFile } from "@/runtime/migration-local-transfer";
import { attachmentSelectionIdentity, samePublicValue } from "@/runtime/migration-client/history-validation";
import { PageControls, appendPage, makeStyles } from "../migration-result-ui";
import { Check, Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useMigrationAction } from "../workbench/useMigrationAction";
import { useHistoricalRead } from "./useHistoricalRead";
import { useHistoricalWorker } from "./useHistoricalWorker";

export function MigrationLocalSupplement({ client, selection, bindings, onBinding }: { client: MobileMigrationClient; selection: HistoricalAttachmentSelection; bindings: HistoricalLocalAttachmentBinding[]; onBinding(binding: HistoricalLocalAttachmentBinding, selected: boolean): void }) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const [operationId, setOperation] = useState<string | null>(null), [requestId, setRequest] = useState<string | null>(null);
  const [pages, setPages] = useState<Array<string | null>>([null]), [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<"UPLOAD" | "FINISH" | "RESUME" | "RUN" | null>(null), [word, setWord] = useState("");
  const [progress, setProgress] = useState<{ phase: string; bytes: number } | null>(null), [cancelError, setCancelError] = useState<string | null>(null);
  const stop = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true; }; }, []);
  const valid = () => mounted.current && client.available();
  const check = () => { if (!valid()) throw new Error("migration_scope_changed"); if (stop.current) throw new Error("local_upload_cancel_requested"); };
  const task = useHistoricalWorker(client, "localRead", { operationId: operationId ?? "" }, operationId !== null);
  const list = useHistoricalRead(client, "localList", { selection, cursor: pages.at(-1) }, true, revision);
  const state = task.result;
  const wrongSelection = !!state && attachmentSelectionIdentity(state.upload.selection) !== attachmentSelectionIdentity(selection);
  const upload = wrongSelection ? undefined : state?.upload, local = upload?.localJob;
  const binding = local?.state.stage === "ready" && local.state.receipt && local.historicalContentVerified === false ? { operationId: upload!.operationId, selection, receipt: local.state.receipt } : null;
  const checked = binding !== null && bindings.some(item => samePublicValue(item, binding));
  const choose = (value: typeof confirm) => { setWord(""); setConfirm(value); };
  async function operate() {
    const mode = confirm; if (!mode) return;
    stop.current = false;
    await action.run(async () => {
      if (mode === "UPLOAD") {
        let id = operationId;
        if (!id) {
          id = requestId ?? migrationRequestId(); setRequest(id);
          let prepared;
          if (requestId) {
            try { prepared = await client.call("localRead", { operationId: id }); }
            catch (error) { if (migrationError(error) !== "local_attachment_upload_not_found") throw error; }
          }
          prepared ??= await client.call("localPrepare", { requestId: id, selection }); check();
          id = prepared.upload.operationId; setOperation(id);
        }
        const fresh = await client.call("localRead", { operationId: id }); check();
        if (attachmentSelectionIdentity(fresh.upload.selection) !== attachmentSelectionIdentity(selection)) throw new Error("migration_invalid_response");
        // The Native job exists before the platform chooser opens. No source URI crosses the RPC boundary.
        const file = await chooseMigrationLocalFile();
        if (!file) return;
        try { check(); } catch (error) { file.close(); throw error; }
        await sendMigrationLocalFile(client, id, file, check, (phase, bytes) => { if (valid()) setProgress({ phase, bytes }); }); check();
      } else {
        if (!operationId) throw new Error("local_upload_operation_required");
        const fresh = await client.call("localRead", { operationId }); check();
        if (fresh.workerRunning) throw new Error("history_worker_running");
        if (mode === "RUN") {
          if (!fresh.upload.localJob) throw new Error("local_upload_finish_required");
          await client.call("localRun", { operationId, expectedSequence: fresh.upload.localJob.state.sequence });
        } else await client.call(mode === "FINISH" ? "localFinish" : "localResume", { operationId, expectedSequence: fresh.upload.sequence });
        check();
      }
    }, () => { setConfirm(null); setRevision(value => value + 1); task.refresh(); });
  }
  async function cancel() {
    stop.current = true; setCancelError(null);
    if (!operationId) return;
    try { await client.call("localCancel", { operationId }); if (valid()) { task.refresh(); setRevision(value => value + 1); } }
    catch (error) { if (valid()) setCancelError(migrationError(error)); }
  }
  return <SettingsGroup title={t("migration_history.local_supplement")} testID="migration-local-supplement">
    <Text style={styles.note}>{t("migration_history.local_notice")}</Text>
    <MigrationProblem code={action.error ?? task.error ?? cancelError ?? (wrongSelection ? "migration_invalid_response" : null) ?? state?.workerError ?? upload?.failureCode ?? local?.state.failureCode ?? list.error}/>
    <View style={styles.actions}><Button testID="migration-local-new" disabled={action.busy || task.busy} onPress={() => { setOperation(null); setRequest(null); setProgress(null); choose("UPLOAD"); }}>{t("migration_history.local_new")}</Button><Button variant="ghost" onPress={() => { setRevision(value => value + 1); task.refresh(); }}>{t("migration_results.refresh")}</Button></View>
    {requestId && !operationId ? <Button testID="migration-local-reconcile" variant="ghost" disabled={action.busy} onPress={() => { void action.run(() => client.call("localRead", { operationId: requestId }), value => setOperation(value.upload.operationId)); }}>{t("migration_workbench.reconcile")} · {requestId}</Button> : null}
    {!operationId ? <><Text style={styles.note}>{t("migration_history.local_records")}</Text>{list.result?.items.map(item => <Button testID={`migration-local-record-${item.operationId}`} key={item.operationId} variant="ghost" disabled={action.busy} onPress={() => { setOperation(item.operationId); setProgress(null); }}>{item.operationId} · {t(`migration_history.local_${item.localJob?.state.stage ?? item.stage}`)}</Button>)}<PageControls previous={pages.length > 1} next={!!list.result?.nextCursor} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = list.result?.nextCursor; if (next) setPages(old => appendPage(old, next)); }}/></> : <View style={styles.stack}>
      <Text selectable style={styles.note}>{operationId}</Text>
      {upload ? <><Text style={styles.title}>{t(`migration_history.local_${local?.state.stage ?? upload.stage}`)}</Text><Text style={styles.note}>{upload.receivedBytes} / {upload.bytes ?? t("migration_history.unknown")} {t("migration_history.bytes")}</Text>{upload.cancelRequested || local?.state.cancelRequested ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}</> : null}
      {progress ? <Text style={styles.note}>{t(`migration_history.${progress.phase}`)} · {progress.bytes} {t("migration_history.bytes")}</Text> : null}
      <Text style={styles.note}>{t(state?.workerRunning ? "migration_results.worker_running" : "migration_workbench.worker_idle")}</Text>
      <View style={styles.actions}>
        <Button testID="migration-local-select" disabled={action.busy || state?.workerRunning || upload?.cancelRequested || local?.state.cancelRequested || !upload || !["prepared", "receiving"].includes(upload.stage)} onPress={() => choose("UPLOAD")}>{t("migration_history.select_same_file")}</Button>
        <Button testID="migration-local-finish" disabled={action.busy || state?.workerRunning || upload?.cancelRequested || !upload || upload.bytes == null || upload.receivedBytes !== upload.bytes || !["receiving", "assembling"].includes(upload.stage)} onPress={() => choose("FINISH")}>{t("migration_history.finish_upload")}</Button>
        <Button testID="migration-local-resume" disabled={action.busy || state?.workerRunning || (!upload?.cancelRequested && !["cancelled", "failed", "outcome_unknown"].includes(upload?.stage ?? ""))} onPress={() => choose("RESUME")}>{t("migration_workbench.resume")}</Button>
        <Button testID="migration-local-run" disabled={action.busy || state?.workerRunning || upload?.cancelRequested || !local || local.state.stage === "ready" || upload.stage !== "authorized"} onPress={() => choose("RUN")}>{t("migration_history.copy_supplement")}</Button>
        <Button testID="migration-local-cancel" variant="ghost" disabled={!upload || upload.cancelRequested || local?.state.stage === "ready"} onPress={() => { void cancel(); }}>{t("migration_workbench.cancel")}</Button>
        <Button variant="ghost" disabled={action.busy} onPress={() => { setOperation(null); setProgress(null); setRevision(value => value + 1); }}>{t("migration_history.local_records")}</Button>
      </View>
      {binding ? <><Check testID="migration-local-bind" label={t("migration_history.bind_supplement")} checked={checked} onPress={() => onBinding(binding, !checked)}/><Button testID="migration-local-download" disabled={action.busy} onPress={() => { void action.run(async () => { const sink = await chooseMigrationDownload(binding.receipt.bytes, binding.receipt.attachmentId); if (!sink) return; stop.current = false; await receiveMigrationAttachment(client, selection, binding.receipt, sink, check, binding.operationId); }); }}>{t("migration_history.download_verified")}</Button></> : null}
    </View>}
    <MigrationUploadCollectionPanel client={client} selection={selection} operationId={upload?.operationId} bindings={bindings} onBinding={onBinding}/>
    {confirm ? <Confirm testID="migration-local-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void operate(); }} onDismiss={() => choose(null)} busy={action.busy}/> : null}
  </SettingsGroup>;
}
