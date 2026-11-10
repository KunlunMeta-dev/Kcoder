import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {useIsFocused} from "expo-router";
import { useRouter } from "expo-router";
import { Button, Field } from "@/components/ui";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import { useSettingsTarget } from "./SettingsTargetContext";
import { MigrationResultsReader } from "@/runtime/migration-results";
import { MobileMigrationClient } from "@/runtime/migration-client";
import { HISTORY_WORKER_STATE_CAPABILITY, historyWorkerObservation, historyWorkerMessage } from "@/runtime/migration-history-worker";
import { migrationIntentStore } from "@/storage/migration-intents";
import { MigrationWorkbench } from "./migration/workbench/MigrationWorkbench";
import { MigrationProblem } from "./migration/workbench/WorkbenchUi";
import { MigrationHistoryWorkspace } from "./migration/history/MigrationHistoryWorkspace";
import { MigrationContinuationOperation } from "./migration/history/MigrationContinuationOperation";
import { useMigrationRead } from "./migration/useMigrationRead";
import { MigrationHistoryRecords } from "./migration/MigrationHistoryRecords";
import { MigrationIssues } from "./migration/MigrationIssues";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useThemedStyles } from "@/theme";
import { Empty, PageControls, ReadNotice, makeStyles, appendPage } from "./migration/migration-result-ui";
export function MigrationResultsSettings() {
    const target = useSettingsTarget();
    const router = useRouter();
    const focused=useIsFocused();
    useLocale();
    const styles = useThemedStyles(makeStyles);
    const identity = JSON.stringify([target.targetIdentity, target.ready, target.error, target.capabilities.appServer?.experimental,focused]);
    const latestIdentity = useRef(identity); latestIdentity.current = identity;
    const [view, setView] = useState<"workbench" | "archive">("workbench");
    const [historySelection, setHistorySelection] = useState<{ scope: string | null; id: string } | null>(null);
    const historyId = historySelection?.scope === target.targetIdentity ? historySelection.id : null;
    const selectHistory = (id: string) => { if (latestIdentity.current === identity) { setHistorySelection({ scope: target.targetIdentity, id }); setView("archive"); } };
    const [owner, setOwner] = useState<{
        identity: string;
        reader: MigrationResultsReader;
        client: MobileMigrationClient;
    } | null>(null);
    useEffect(() => {
        if (!focused || !target.ready || target.error || !target.targetIdentity || !target.profile)
            return;
        let current = true;
        const valid = () => current && latestIdentity.current === identity;
        const capabilities = target.capabilities.appServer?.experimental ?? {};
        const reader = new MigrationResultsReader(target.request, capabilities, valid);
        const client = new MobileMigrationClient(target.request, capabilities, migrationIntentStore(target.profile, target.targetIdentity, valid), valid, target.workspacePath);
        setOwner({ identity, reader, client });
        return () => { current = false; reader.close(); client.close(); };
    }, [identity, target.request]);
    const reader = owner?.identity === identity && owner.reader.isAvailable() ? owner.reader : null;
    const onOpenThread = (threadId: string) => {
      if (latestIdentity.current !== identity || !owner?.client.available() || !target.profile || !target.serverId) return;
      router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: target.profile.id, serverId: target.serverId, threadId, cwd: target.workspacePath ?? "/", title: t("migration_history.imported_session") } });
    };
    return <>
    <SettingsGroup><Text style={styles.note}>{t("migration_results.readonly_note")}</Text></SettingsGroup>
    {!target.ready ? <Text style={styles.note}>{t("migration_results.select_target")}</Text> : null}
    {reader && owner ? <View key={identity}>
      <View style={styles.actions}>
        <Button testID="migration-workbench-open" variant={view === "workbench" ? "secondary" : "ghost"} onPress={() => { setView("workbench"); setHistorySelection(null); }}>{t("migration_workbench.manage")}</Button>
        <Button testID="migration-archive-open" variant={view === "archive" ? "secondary" : "ghost"} onPress={() => { setView("archive"); setHistorySelection(null); }}>{t("migration_workbench.archives")}</Button>
      </View>
      {view === "workbench" ? owner.client.supports("scan") ? <MigrationWorkbench client={owner.client} onHistory={selectHistory}/> : <MigrationProblem code="migration_update_required"/> : historyId ? <MigrationHistoryWorkspace key={historyId} client={owner.client} reader={reader} jobId={historyId} onHistory={selectHistory} onOpenThread={onOpenThread}/> : <MigrationResultsBody reader={reader} client={owner.client} onHistory={selectHistory} onOpenThread={onOpenThread}/>}
    </View> : null}
  </>;
}
function MigrationResultsBody({ reader, client, onHistory, onOpenThread }: {
    reader: MigrationResultsReader;
    client: MobileMigrationClient;
    onHistory(id: string): void;
    onOpenThread(id: string): void;
}) {
    const styles = useThemedStyles(makeStyles);
    const [mode, setMode] = useState<"jobs" | "historyJobs" | "continuation">("jobs");
    const [selected, setSelected] = useState<string | null>(null);
    return <View style={styles.stack}>
    <View style={styles.actions}>
      {(["jobs", "historyJobs", "continuation"] as const).map(value => <Button key={value} variant={mode === value ? "secondary" : "ghost"} onPress={() => { setMode(value); setSelected(null); }}>{t(`migration_results.tab_${value === "historyJobs" ? "history_jobs" : value}`)}</Button>)}
    </View>
    {!reader.supports(mode) ? <ReadNotice error="unsupported"/> : mode === "continuation" ? <KnownContinuation reader={reader} client={client} onOpenThread={onOpenThread}/> : selected ? <>
      <Button variant="ghost" onPress={() => setSelected(null)}>{t("migration_results.back_to_jobs")}</Button>
      {mode === "jobs" ? <ConfigurationJob key={selected} reader={reader} jobId={selected}/> : <MigrationHistoryWorkspace key={selected} reader={reader} client={client} jobId={selected} onHistory={onHistory} onOpenThread={onOpenThread}/>}
    </> : <JobList key={mode} reader={reader} name={mode} onSelect={setSelected} workerStateNegotiated={client.supportsCapability(HISTORY_WORKER_STATE_CAPABILITY)}/>}
  </View>;
}
export function JobList({ reader, name, onSelect, workerStateNegotiated = false }: {
    reader: MigrationResultsReader;
    name: "jobs" | "historyJobs";
    onSelect(id: string): void;
    workerStateNegotiated?: boolean;
}) {
    const [pages, setPages] = useState<Array<string | null>>([null]);
    const [revision, setRevision] = useState(0);
    const page = useMigrationRead(reader, name, { cursor: pages.at(-1) ?? null }, true, revision);
    const rows = page.value?.jobs ?? [];
    return <SettingsGroup testID="migration-results-list">
    <Button variant="ghost" onPress={() => setRevision(v => v + 1)}>{t("migration_results.refresh")}</Button>
    <ReadNotice loading={page.loading} error={page.error}/>
    {rows.map(row => {
      const unknown = "stage" in row.job && "workerRunning" in row && historyWorkerObservation(row, workerStateNegotiated) === "unknown";
      const status = unknown ? t("migration_history.worker_unknown_label") : "workerRunning" in row && row.workerRunning ? t("migration_results.worker_running") : undefined;
      return <SettingsRow key={row.job.jobId} testID={`migration-job-${row.job.jobId}`} label={row.job.jobId} labelNumberOfLines={1} note={t(`migration_results.stage_${"stage" in row.job ? row.job.stage : row.job.status}`)} value={status} onPress={() => onSelect(row.job.jobId)}/>;
    })}
    {page.value && rows.length === 0 ? <Empty /> : null}
    <PageControls onFirst={() => setPages([null])} previous={pages.length > 1} next={!!page.value?.nextCursor} onPrevious={() => setPages(p => p.slice(0, -1))} onNext={() => { const cursor = page.value?.nextCursor; if (cursor)
        setPages(p => appendPage(p, cursor)); }}/>
  </SettingsGroup>;
}
export function ConfigurationJob({ reader, jobId }: {
    reader: MigrationResultsReader;
    jobId: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const [revision, setRevision] = useState(0);
    const page = useMigrationRead(reader, "job", { jobId }, true, revision);
    const [pages, setPages] = useState<Array<string | null>>([null]);
    const items = useMigrationRead(reader, "items", { jobId, cursor: pages.at(-1) ?? null }, !!page.value, revision);
    return <SettingsGroup>
    <Button variant="ghost" onPress={() => setRevision(v => v + 1)}>{t("migration_results.refresh")}</Button>
    <ReadNotice loading={page.loading || items.loading} error={page.error ?? items.error}/>
    {page.value ? <View style={styles.stack}>
      <Text style={styles.title}>{t(`migration_results.stage_${page.value.job.status}`)}</Text>
      <Text style={styles.note}>{t("migration_results.saved_count", { count: page.value.job.committedItems, total: page.value.job.totalItems })}</Text>
      {page.value.job.hasUnconfirmedOutcomes ? <Text style={styles.warning}>{t("migration_results.unknown_outcome")}</Text> : null}
      {page.value.job.status === "cancel_requested" ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
      <Text style={styles.note}>{t("migration_results.saved_not_verified")}</Text>
      <MigrationIssues issues={page.value.issues}/>
      {items.value?.items.map(item => <View key={item.id} style={styles.row}>
        <Text selectable style={styles.text}>{item.sourceName}</Text>
        <Text style={styles.note}>{t(`migration_results.item_${item.status}`)}</Text>
        <MigrationIssues issues={item.issues}/>
      </View>)}
      <PageControls onFirst={() => setPages([null])} previous={pages.length > 1} next={!!items.value?.nextCursor} onPrevious={() => setPages(p => p.slice(0, -1))} onNext={() => { const cursor = items.value?.nextCursor; if (cursor)
            setPages(p => appendPage(p, cursor)); }}/>
    </View> : null}
  </SettingsGroup>;
}
export function HistoryJob({ reader, jobId }: {
    reader: MigrationResultsReader;
    jobId: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const [revision, setRevision] = useState(0);
    const page = useMigrationRead(reader, "history", { jobId }, true, revision);
    return <View style={styles.stack}>
    <SettingsGroup>
      <Button variant="ghost" onPress={() => setRevision(v => v + 1)}>{t("migration_results.refresh")}</Button>
      <ReadNotice loading={page.loading} error={page.error}/>
      {page.value ? <View style={styles.stack}>
        <Text style={styles.title}>{t(`migration_results.stage_${page.value.job.stage}`)}</Text>
        <Text style={styles.note}>{t(historyWorkerMessage(historyWorkerObservation(page.value, false)))}</Text>
        {page.value.job.cancelRequested && page.value.job.stage !== "cancelled" ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
        {page.value.job.normalization?.recordsWithDiagnostics ? <Text style={styles.warning}>{t("migration_results.diagnostic_count", { count: page.value.job.normalization.recordsWithDiagnostics })}</Text> : null}
        {page.value.progress ? <Text style={styles.note}>{t("migration_results.progress", { processed: page.value.progress.processed, total: page.value.progress.total })}</Text> : null}
        {page.value.job.failureCode || page.value.workerError ? <Text selectable style={styles.error}>{page.value.job.failureCode ?? page.value.workerError}</Text> : null}
      </View> : null}
    </SettingsGroup>
    {page.value?.job.stage === "normalized" ? (reader.supports("transcript") ? <MigrationHistoryRecords reader={reader} jobId={jobId}/> : <ReadNotice error="unsupported"/>) : null}
  </View>;
}
function KnownContinuation({ reader, client, onOpenThread }: {
    reader: MigrationResultsReader;
    client: MobileMigrationClient;
    onOpenThread(id: string): void;
}) {
    const styles = useThemedStyles(makeStyles);
    const [draft, setDraft] = useState("");
    const [id, setId] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const page = useMigrationRead(reader, "continuation", { jobId: id ?? "" }, id !== null && !client.supports("continuationRead"), revision);
    return <SettingsGroup>
    <Text style={styles.note}>{t("migration_results.known_id_note")}</Text>
    <Field testID="migration-known-continuation-id" label={t("migration_results.known_id")} value={draft} onChangeText={value => { setDraft(value); setId(null); }} autoCapitalize="none" autoCorrect={false} maxLength={128}/>
    <Button testID="migration-known-continuation-read" variant="ghost" disabled={!/^[A-Za-z0-9_-]{1,128}$/.test(draft.trim())} onPress={() => { setId(draft.trim()); setRevision(v => v + 1); }}>{t("migration_results.read_result")}</Button>
    <ReadNotice loading={page.loading} error={page.error}/>
    {id && client.supports("continuationRead") ? <MigrationContinuationOperation key={id} client={client} jobId={id} onOpenThread={onOpenThread}/> : null}
    {page.value ? <View style={styles.stack}>
      <Text style={styles.title}>{t(`migration_results.stage_${page.value.job.stage}`)}</Text>
      <Text selectable style={styles.note}>{page.value.job.jobId}</Text>
      {page.value.workerRunning ? <Text style={styles.note}>{t("migration_results.worker_running")}</Text> : null}
      {page.value.job.cancelRequested && page.value.job.stage !== "cancelled" ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
      {page.value.job.stage === "publish_unknown" ? <Text style={styles.warning}>{t("migration_results.unknown_outcome")}</Text> : null}
      {page.value.job.threadId ? <Text selectable style={styles.text}>{t("migration_results.result_session", { id: page.value.job.threadId })}</Text> : null}
      {page.value.job.failureCode || page.value.workerError ? <Text selectable style={styles.error}>{page.value.job.failureCode ?? page.value.workerError}</Text> : null}
    </View> : null}
  </SettingsGroup>;
}
