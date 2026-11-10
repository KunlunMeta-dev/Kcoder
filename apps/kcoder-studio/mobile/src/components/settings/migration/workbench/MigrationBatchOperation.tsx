import { MigrationProjectMapping } from './MigrationProjectMapping';
import { MigrationJobInstructionPreview } from './MigrationJobInstructionPreview';
import { MigrationResourceBudgetPanel } from './MigrationResourceBudgetPanel';
import { MigrationPrivateCredentials } from './MigrationPrivateCredentials';
import { MigrationDefinitionPreview } from '../source/MigrationDefinitionPreview';
import { MigrationCodexLayerReport } from "./MigrationCodexLayerReport";
import { MigrationConfigurationLayers } from "./MigrationConfigurationLayers";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { migrationError, migrationRequestId, type MobileMigrationClient, type MigrationJobReadResult, type MigrationCalls } from "@/runtime/migration-client";
import { makeStyles, PageControls } from "../migration-result-ui";
import { MigrationIssues } from "../MigrationIssues";
import { useMigrationAction } from "./useMigrationAction";
import { Confirm, MigrationProblem } from "./WorkbenchUi";
type Snapshot = MigrationCalls["batchRead"][1];

export function MigrationBatchOperation({ client, job, onEdit, onHistory }: { client: MobileMigrationClient; job: MigrationJobReadResult; onEdit(job: MigrationJobReadResult): void; onHistory(id: string): void }) {
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const [state, setState] = useState<Snapshot | null>(null);
  const latest = useRef<Snapshot | null>(null);
  const epoch = useRef(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"IMPORT" | "RESUME" | "UNDO" | "CANCEL" | null>(null);
  const [word, setWord] = useState("");
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const ticket = epoch.current;
    let busyRetries = 0;
    async function observe() {
      try {
        const next = await client.call("batchRead", { jobId: job.job.jobId });
        if (!active || !client.available() || ticket !== epoch.current) return;
        if (!latest.current || next.state.job.sequence >= latest.current.state.job.sequence) { latest.current = next; setState(next); }
        setError(null); busyRetries = 0;
        if (latest.current?.workerRunning) timer = setTimeout(() => { void observe(); }, 600);
      } catch (cause) {
        if (!active || !client.available() || ticket !== epoch.current) return;
        const code = migrationError(cause);
        if (["history_catalog_busy", "migration_catalog_busy", "migration_busy"].includes(code) && busyRetries++ < 8) timer = setTimeout(() => { void observe(); }, 250);
        else setError(code);
      }
    }
    void observe();
    return () => { active = false; clearTimeout(timer); };
  }, [client, job.job.jobId, revision]);
  const current = state?.state ?? job;
  const running = state?.workerRunning;
  const planId = current.batch?.planId;
  function change(value: typeof confirm) { setConfirm(value); setWord(""); }
  async function execute() {
    const observed = latest.current;
    if (!observed || !confirm || !observed.state.batch?.planId) return;
    epoch.current++;
    const captured = observed.state;
    const requestId = migrationRequestId();
    const mode = confirm === "IMPORT" ? "apply" : confirm === "RESUME" ? "resume" : confirm === "CANCEL" ? "cancel" : "rollback";
    await action.run(() => client.operateBatch(captured.job.jobId, captured.batch!.planId!, mode, requestId), next => {
      if (!latest.current || next.state.job.sequence >= latest.current.state.job.sequence) { latest.current = next; setState(next); }
    });
    if (client.available()) { setConfirm(null); setRevision(value => value + 1); }
  }
  return <View style={styles.stack} testID="migration-batch-operation">
    <SettingsGroup title={t("migration_workbench.preview")}>
      <Text selectable style={styles.note}>{current.job.jobId}</Text>
      <Text style={styles.title}>{t(`migration_results.stage_${current.job.status}`)}</Text>
      <Text style={styles.note}>{t("migration_results.saved_count", { count: current.job.committedItems, total: current.job.totalItems })}</Text>
      <Text style={styles.note}>{t("migration_workbench.plan_count", { count: current.batch?.selectedItems ?? "?" })}</Text>
      {running === true ? <Text style={styles.note}>{t("migration_results.worker_running")}</Text> : state ? <Text style={styles.note}>{t("migration_workbench.worker_idle")}</Text> : null}
      {state?.progress ? <Text style={styles.note}>{t("migration_workbench.batch_progress", { at: state.progress.actionIndex + 1, total: state.progress.totalActions })}{state.progress.history ? ` · ${state.progress.history.phase} ${state.progress.history.processed}/${state.progress.history.total} ${state.progress.history.unit}` : ""}</Text> : null}
      {current.job.hasUnconfirmedOutcomes ? <Text style={styles.warning}>{t("migration_results.unknown_outcome")}</Text> : null}
      {current.job.status === "cancel_requested" ? <Text style={styles.warning}>{t("migration_results.cancel_requested")}</Text> : null}
      <Text style={styles.note}>{t("migration_results.saved_not_verified")}</Text>
      <Text style={styles.note}>{t("migration_workbench.undo_boundary")}</Text>
      <MigrationIssues issues={current.issues}/>
      <MigrationProblem code={action.error ?? error ?? state?.workerError}/>
      <View style={styles.actions}>
        <Button testID="migration-batch-refresh" variant="ghost" onPress={() => setRevision(value => value + 1)}>{t("migration_results.refresh")}</Button>
        <Button testID="migration-batch-edit" variant="ghost" disabled={!state || running || action.busy || !["ready", "scanning"].includes(current.job.status)} onPress={() => onEdit(current)}>{t("migration_workbench.edit_selection")}</Button>
        <Button testID="migration-batch-import" disabled={!state || !planId || running || action.busy || current.job.status !== "ready" || current.job.hasUnconfirmedOutcomes} onPress={() => change("IMPORT")}>{t("migration_workbench.import")}</Button>
        <Button testID="migration-batch-cancel" disabled={!state || !planId || action.busy || !running || current.job.status === "cancel_requested"} onPress={() => change("CANCEL")}>{t("migration_workbench.cancel")}</Button>
        <Button testID="migration-batch-resume" disabled={!state || !planId || running || action.busy || (["ready", "completed", "rolled_back"].includes(current.job.status) || current.job.status === "completed_with_issues" && !current.batch?.unresolvedActions)} onPress={() => change("RESUME")}>{t("migration_workbench.resume")}</Button>
        <Button testID="migration-batch-undo" variant="danger" disabled={!state || !planId || running || action.busy || current.job.status === "rolled_back"} onPress={() => change("UNDO")}>{t("migration_workbench.undo")}</Button>
      </View>
      {confirm ? <Confirm testID="migration-batch-confirm" keyword={confirm} value={word} onChange={setWord} onConfirm={() => { void execute(); }} onDismiss={() => change(null)} busy={action.busy}/> : null}
    </SettingsGroup>
    <MigrationResourceBudgetPanel client={client} job={current}/>
    <MigrationPrivateCredentials client={client} job={current} onPrepared={() => setRevision(value => value + 1)}/>
    <BatchItems key={`${current.job.jobId}:${current.job.sequence}`} client={client} job={current} onHistory={onHistory} parentBusy={action.busy}/>
  </View>;
}
function BatchItems({ client, job, onHistory, parentBusy }: { client: MobileMigrationClient; job: MigrationJobReadResult; onHistory(id: string): void; parentBusy: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<MigrationCalls["items"][1] | null>(null);
  const [details, setDetails] = useState<MigrationCalls["itemPlan"][1] | null>(null);
  useEffect(() => { void action.run(() => client.call("items", { jobId: job.job.jobId, pageIndex: index }), value => { setPage(value); setDetails(null); }); }, [client, job.job.jobId, index]);
  return <SettingsGroup title={t("migration_workbench.results")}>
    <MigrationProblem code={action.error}/>
    {action.error === "history_job_not_found" ? <Text style={styles.note}>{t("migration_workbench.history_not_created")}</Text> : null}
    {page?.items.map(item => { const planned = page.planned?.find(row => row.itemId === item.id); return <View key={item.id} style={styles.row}>
      <Text style={styles.title}>{item.sourceName}</Text><Text style={styles.note}>{t(`migration_results.item_${item.status}`)}{planned?.targetName ? ` · ${planned.targetName}` : ""}</Text>
      <MigrationIssues issues={item.issues}/>
      {item.category === 'project' ? <MigrationProjectMapping readOnly client={client} jobId={job.job.jobId} itemId={item.id}/> : null}
      {item.category === 'instructions' && client.supports('instructionBody') ? <MigrationJobInstructionPreview client={client} jobId={job.job.jobId} itemId={item.id}/> : null}
      {['agent', 'hook'].includes(item.category) ? <MigrationDefinitionPreview client={client} jobId={job.job.jobId} itemId={item.id}/> : null}
      {["provider", "mcp"].includes(item.category) ? job.source === "codex" ? <MigrationCodexLayerReport client={client} target={{kind:"job",jobId:job.job.jobId,itemId:item.id}}/> : <MigrationConfigurationLayers client={client} target={{ kind: "job", jobId: job.job.jobId, itemId: item.id }}/> : null}
      {planned?.errorCode ? <Text style={styles.error}>{planned.errorCode}</Text> : null}
      {planned ? <Button testID={`migration-plan-details-${item.id}`} variant="ghost" disabled={action.busy} onPress={() => { void action.run(() => client.call("itemPlan", { jobId: job.job.jobId, itemId: item.id }), setDetails); }}>{t("migration_workbench.details")}</Button> : null}
      {planned?.historyJobId ? <Button testID={`migration-open-history-${item.id}`} variant="ghost" disabled={parentBusy || action.busy} onPress={() => {
        if (parentBusy || action.busy) return;
        void action.run(() => client.call("historyRead", { jobId: planned.historyJobId! }), value => onHistory(value.job.jobId));
      }}>{t("migration_workbench.read_history")}</Button> : null}
    </View>; })}
    {details ? <View style={styles.row} testID="migration-plan-details">
      <Text selectable style={styles.text}>{details.item.targetName}</Text>
      {details.provider ? <Text selectable style={styles.note}>{details.provider.endpoint ?? "—"} · {details.provider.model ?? "—"} · {details.provider.contextWindowTokens ?? "?"}/{details.provider.outputHeadroomTokens ?? "?"}/{details.provider.maxOutputTokens ?? "?"}</Text> : null}
      {details.mcp ? <Text selectable style={styles.note}>{details.mcp.transport} · {details.mcp.command} · {details.mcp.url} · {details.mcp.args?.length ?? "?"} args</Text> : null}
      <Text style={styles.note}>{t("migration_workbench.activation", { enabled: String(details.item.enabled) })}</Text>
    </View> : null}
    <PageControls previous={index > 0 && !action.busy} next={!!page?.nextCursor && !action.busy} onPrevious={() => { setPage(null); setIndex(value => value - 1); }} onNext={() => { setPage(null); setIndex(value => value + 1); }}/>
  </SettingsGroup>;
}
