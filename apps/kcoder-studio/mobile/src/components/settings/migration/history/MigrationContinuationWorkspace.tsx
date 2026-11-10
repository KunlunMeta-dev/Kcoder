import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Field } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import type { MigrationIntent } from "@/storage/migration-intents";
import type { HistoricalLocalAttachmentBinding } from "../../../../../../shared/generated/contracts";
import { createOrReconcileContinuation, MIGRATION_CONTEXT_POLICY } from "@/runtime/migration-continuation";
import { PageControls, makeStyles } from "../migration-result-ui";
import { Check, Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { useMigrationAction } from "../workbench/useMigrationAction";
import { MigrationContinuationOperation } from "./MigrationContinuationOperation";

export function MigrationContinuationWorkspace({ client, sourceJobId, viewId, bindings, onOpenThread }: { client: MobileMigrationClient; sourceJobId: string; viewId: string; bindings: HistoricalLocalAttachmentBinding[]; onOpenThread?(id: string): void }) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const [workMode, setMode] = useState<"kcoder" | "kworker">("kcoder"), [model, setModel] = useState(""), [template, setTemplate] = useState("");
  const [word, setWord] = useState(""), [confirm, setConfirm] = useState(false), [jobId, setJob] = useState<string | null>(null);
  const [records, setRecords] = useState<MigrationIntent[]>([]), [page, setPage] = useState(0);
  const refresh = () => action.run(() => client.intents(), rows => { setRecords(rows.filter(row => row.method === "migration/history/continuation/create" && row.sourceJobId === sourceJobId && row.viewId === viewId)); });
  useEffect(() => { void refresh(); }, [client, sourceJobId, viewId]);
  const unique = records.filter((row, index) => records.findIndex(other => other.jobId === row.jobId) === index);
  async function create() {
    if (word !== "CREATE") return;
    await action.run(() => createOrReconcileContinuation(client, sourceJobId, viewId, { studioWorkMode: workMode, ...(model.trim() ? { model: model.trim() } : {}), ...(template.trim() ? { settingsTemplate: template.trim() } : {}), ...(bindings.length ? { localAttachments: bindings } : {}) }), value => { setJob(value.job.jobId); setConfirm(false); });
  }
  return <SettingsGroup title={t("migration_history.continue")} testID="migration-continuation-workspace">
    <Text style={styles.note}>{t("migration_history.continue_note")}</Text>
    <Text style={styles.note}>{t("migration_history.context_budget", { bytes: MIGRATION_CONTEXT_POLICY.maxContextBytes, count: MIGRATION_CONTEXT_POLICY.maxEntries })}</Text>
    <MigrationProblem code={action.error}/>
    {jobId ? <><Button testID="migration-continuation-back" variant="ghost" onPress={() => { setJob(null); void refresh(); }}>{t("migration_history.continuation_records")}</Button><MigrationContinuationOperation key={jobId} client={client} jobId={jobId} onOpenThread={onOpenThread}/></> : <View style={styles.stack}>
      <View style={styles.actions}>{(["kcoder", "kworker"] as const).map(value => <Check key={value} testID={`migration-continuation-mode-${value}`} checked={value === workMode} label={value === "kcoder" ? "KCoder" : "KWorker"} disabled={action.busy || confirm} onPress={() => setMode(value)}/>)}</View>
      <Field testID="migration-continuation-model" label={t("migration_history.model_optional")} value={model} onChangeText={setModel} editable={!action.busy && !confirm} autoCapitalize="none" autoCorrect={false} maxLength={256}/>
      <Field testID="migration-continuation-template" label={t("migration_history.template_optional")} value={template} onChangeText={setTemplate} editable={!action.busy && !confirm} autoCapitalize="none" autoCorrect={false} maxLength={256}/>
      {bindings.length ? <Text style={styles.warning}>{t("migration_history.bound_supplements", { count: bindings.length })}</Text> : <Text style={styles.note}>{t("migration_history.no_supplements")}</Text>}
      <Button testID="migration-continuation-prepare" disabled={action.busy || confirm} onPress={() => { setWord(""); setConfirm(true); }}>{t("migration_history.prepare_continuation")}</Button>
      {confirm ? <Confirm testID="migration-continuation-create-confirm" keyword="CREATE" value={word} onChange={setWord} onConfirm={() => { void create(); }} onDismiss={() => setConfirm(false)} busy={action.busy}/> : null}
      <Text style={styles.title}>{t("migration_history.continuation_records")}</Text>
      <Button testID="migration-continuation-records-refresh" disabled={action.busy} variant="ghost" onPress={() => { void refresh(); }}>{t("migration_workbench.reconcile")}</Button>
      {unique.slice(page * 10, page * 10 + 10).map(row => <Button testID={`migration-continuation-record-${row.jobId}`} key={row.id} variant="ghost" disabled={action.busy} onPress={() => { if (row.jobId) setJob(row.jobId); }}>{row.jobId} · {row.phase === "acknowledged" ? t("migration_history.receipt_saved") : t("migration_results.unknown_outcome")}</Button>)}
      <PageControls previous={page > 0} next={(page + 1) * 10 < unique.length} onPrevious={() => setPage(old => old - 1)} onNext={() => setPage(old => old + 1)}/>
    </View>}
  </SettingsGroup>;
}
