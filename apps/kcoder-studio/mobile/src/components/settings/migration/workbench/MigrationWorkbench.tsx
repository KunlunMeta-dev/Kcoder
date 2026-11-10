import { MigrationDefinitionSources } from '../source/MigrationDefinitionSources';
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup, SettingsRow } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient, MigrationBatchPluginSource, MigrationJobReadResult, MigrationCalls } from "@/runtime/migration-client";
import type { MigrationIntent } from "@/storage/migration-intents";
import { makeStyles, PageControls, appendPage } from "../migration-result-ui";
import { useMigrationAction } from "./useMigrationAction";
import { Confirm, MigrationProblem } from "./WorkbenchUi";
import { MigrationSources } from "./MigrationSources";
import { MigrationBatchEditor } from "./MigrationBatchEditor";
import { MigrationBatchOperation } from "./MigrationBatchOperation";
import { MigrationPluginRecord } from "./MigrationPluginRecord";
import { recoverHistoricalLocator } from "@/runtime/migration-history-recovery";
import { MigrationContinuationOperation } from "../history/MigrationContinuationOperation";
import { MigrationMemoryManager } from '../memory/MigrationMemoryManager';
import { MigrationSourceWorkspace } from '../source/MigrationSourceWorkspace';

export function MigrationWorkbench({ client, onHistory }: { client: MobileMigrationClient; onHistory(id: string): void }) {
  const styles = useThemedStyles(makeStyles);
  const [mode, setMode] = useState<"new" | "records" | "plugins" | "recovery" | "memory" | "source" | "definitions">("new");
  const [job, setJob] = useState<MigrationJobReadResult | null>(null);
  const [edit, setEdit] = useState(false);
  const [plugin, setPlugin] = useState<MigrationBatchPluginSource | undefined>();
  const open = (value: MigrationJobReadResult) => { setJob(value); setEdit(!value.batch?.planId && ["ready", "scanning"].includes(value.job.status)); };
  return <View style={styles.stack} testID="migration-workbench">
    <View style={styles.actions}>{(["new", "records", "plugins", "recovery", "memory", "source", "definitions"] as const).map(value => <Button key={value} testID={`migration-tab-${value}`} variant={value === mode && !job ? "secondary" : "ghost"} onPress={() => { setMode(value); setJob(null); setPlugin(undefined); }}>{t(value === 'definitions' ? 'migration_definitions.title' : value === 'source' ? 'migration_source.title' : value === 'memory' ? 'migration_memory.title' : `migration_workbench.tab_${value}`)}</Button>)}</View>
    {job ? <>
      <Button testID="migration-close-job" variant="ghost" onPress={() => setJob(null)}>{t("migration_results.back_to_jobs")}</Button>
      {edit ? <MigrationBatchEditor key={job.job.jobId} client={client} job={job} onPreview={value => { setJob(value); setEdit(false); }}/> : <MigrationBatchOperation key={job.job.jobId} client={client} job={job} onEdit={value => { setJob(value); setEdit(true); }} onHistory={onHistory}/>}
    </> : mode === 'definitions' ? <MigrationDefinitionSources client={client} onJob={open}/> : mode === 'source' ? <MigrationSourceWorkspace client={client} onJob={open}/> : mode === 'memory' ? <MigrationMemoryManager client={client} onJob={open}/> : mode === "new" ? <MigrationSources key={plugin?.operationId ?? "new"} client={client} onJob={open} initialPlugin={plugin} onHistory={onHistory}/> : mode === "records" ? <BatchRecords client={client} onJob={open}/> : mode === "plugins" ? <PluginRecords client={client} onUse={binding => { setPlugin(binding); setMode("new"); }} onJob={open}/> : <Recovery client={client} onJob={open} onHistory={onHistory} onUse={binding => { setPlugin(binding); setMode("new"); }}/>}
  </View>;
}
function BatchRecords({ client, onJob }: { client: MobileMigrationClient; onJob(value: MigrationJobReadResult): void }) {
  const action = useMigrationAction(client);
  const styles = useThemedStyles(makeStyles);
  const [pages, setPages] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState<MigrationCalls["batchRead"][1] | null>(null);
  const [records, setRecords] = useState<{ jobs: Array<{ job: { jobId: string; status: string } }>; nextCursor?: string | null } | null>(null);
  // The existing reader owns the read-only list capability; no alternate record index is built.
  const [reader] = useState(() => client);
  useEffect(() => { void action.run(() => reader.call("jobs", { cursor: pages.at(-1) ?? null }), setRecords); }, [reader, pages]);
  return <SettingsGroup title={t("migration_workbench.tab_records")}>
    <MigrationProblem code={action.error}/>
    <Button testID="migration-records-refresh" variant="ghost" onPress={() => setPages(value => [...value])}>{t("migration_results.refresh")}</Button>
    {records?.jobs.map(row => <SettingsRow key={row.job.jobId} testID={`migration-batch-record-${row.job.jobId}`} label={row.job.jobId} note={t(`migration_results.stage_${row.job.status}`)} onPress={() => { void action.run(() => client.call("batchRead", { jobId: row.job.jobId }), value => { setPage(value); onJob(value.state); }); }}/>) }
    {records?.jobs.length === 0 ? <Text style={styles.note}>{t("migration_results.empty")}</Text> : null}
    {page?.workerError ? <MigrationProblem code={page.workerError}/> : null}
    <PageControls previous={pages.length > 1 && !action.busy} next={!!records?.nextCursor && !action.busy} onPrevious={() => setPages(value => value.slice(0, -1))} onNext={() => { if (records?.nextCursor) setPages(value => appendPage(value, records.nextCursor!)); }}/>
  </SettingsGroup>;
}
function PluginRecords({ client, onUse, onJob }: { client: MobileMigrationClient; onUse(value: MigrationBatchPluginSource): void; onJob(value: MigrationJobReadResult): void }) {
  const action = useMigrationAction(client);
  const styles = useThemedStyles(makeStyles);
  const [pages, setPages] = useState<Array<string | null>>([null]);
  const [value, setValue] = useState<MigrationCalls["pluginList"][1] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if (!selected) void action.run(() => client.call("pluginList", { cursor: pages.at(-1) ?? null }), setValue); }, [client, pages, selected]);
  return <SettingsGroup title={t("migration_workbench.tab_plugins")}>
    <MigrationProblem code={action.error}/>
    {selected ? <>
      <Button testID="migration-plugin-back" variant="ghost" onPress={() => setSelected(null)}>{t("migration_results.back_to_jobs")}</Button>
      <MigrationPluginRecord key={selected} client={client} operationId={selected} onUse={onUse} onBatch={jobId => { void action.run(() => client.call("batchRead", { jobId }), value => onJob(value.state)); }}/>
    </> : <>
      <Button testID="migration-plugin-records-refresh" variant="ghost" onPress={() => setPages(value => [...value])}>{t("migration_results.refresh")}</Button>
      {value?.items.map(job => <SettingsRow key={job.operationId} testID={`migration-plugin-record-${job.operationId}`} label={job.name} note={`${job.stage} · ${job.operationId}`} onPress={() => setSelected(job.operationId)}/>)}
      {value?.items.length === 0 ? <Text style={styles.note}>{t("migration_results.empty")}</Text> : null}
      <PageControls previous={pages.length > 1 && !action.busy} next={!!value?.nextCursor && !action.busy} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { if (value?.nextCursor) setPages(old => appendPage(old, value.nextCursor!)); }}/>
    </>}
  </SettingsGroup>;
}
function Recovery({ client, onJob, onUse, onHistory }: { client: MobileMigrationClient; onJob(value: MigrationJobReadResult): void; onUse(value: MigrationBatchPluginSource): void; onHistory(id: string): void }) {
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const [rows, setRows] = useState<MigrationIntent[]>([]);
  const [page, setPage] = useState(0);
  const [operationId, setOperation] = useState<string | null>(null);
  const [continuationId, setContinuation] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => { void action.run(() => client.intents(), setRows); }, [client]);
  return <SettingsGroup title={t("migration_workbench.tab_recovery")}>
    <Text style={styles.note}>{t("migration_workbench.recovery_note")}</Text>
    <MigrationProblem code={action.error}/>
    <Button testID="migration-recovery-refresh" variant="ghost" onPress={() => { void action.run(() => client.intents(), setRows); }}>{t("migration_results.refresh")}</Button>
    {rows.slice(page * 10, page * 10 + 10).map(row => <View key={row.id} style={styles.row}>
      <Text style={styles.title}>{row.phase}</Text><Text selectable style={styles.note}>{row.method} · {row.requestId ?? row.operationId ?? row.jobId ?? row.id}</Text>
      {row.method.startsWith("migration/history/") ? <Button testID={`migration-recover-history-${row.id}`} disabled={action.busy} onPress={() => { void action.run(() => recoverHistoricalLocator(client, row), value => { if (value.continuationJobId) setContinuation(value.continuationJobId); else onHistory(value.sourceJobId); }); }}>{t("migration_workbench.reconcile")}</Button> : row.method.startsWith("migration/plugin/") && (row.operationId || row.requestId) ? <Button testID={`migration-recover-plugin-${row.id}`} onPress={() => setOperation(row.operationId ?? row.requestId!)}>{t("migration_workbench.reconcile")}</Button> : row.jobId ? <Button testID={`migration-recover-job-${row.id}`} onPress={() => { void action.run(() => client.call("batchRead", { jobId: row.jobId! }), result => onJob(result.state)); }}>{t("migration_workbench.reconcile")}</Button> : <Text style={styles.warning}>{t("migration_workbench.scan_unknown")}</Text>}
      {row.phase !== "reviewed" && row.phase !== "acknowledged" ? <Button testID={`migration-archive-locator-${row.id}`} variant="ghost" onPress={() => { setArchiving(row.id); setConfirmation(""); }}>{t("migration_workbench.archive_locator")}</Button> : null}
    </View>)}
    {archiving ? <View><Text style={styles.warning}>{t("migration_workbench.archive_locator_note")}</Text><Confirm testID="migration-locator-confirm" keyword="ARCHIVE" value={confirmation} onChange={setConfirmation} busy={action.busy} onDismiss={() => setArchiving(null)} onConfirm={() => { void action.run(async () => { await client.archiveLocator(archiving, confirmation); return client.intents(); }, value => { setRows(value); setArchiving(null); }); }}/></View> : null}
    <PageControls previous={page > 0} next={(page + 1) * 10 < rows.length} onPrevious={() => setPage(value => value - 1)} onNext={() => setPage(value => value + 1)}/>
    {operationId ? <MigrationPluginRecord key={operationId} client={client} operationId={operationId} onUse={onUse} onBatch={jobId => { void action.run(() => client.call("batchRead", { jobId }), result => onJob(result.state)); }}/> : null}
    {continuationId ? <MigrationContinuationOperation key={continuationId} client={client} jobId={continuationId}/> : null}
  </SettingsGroup>;
}
