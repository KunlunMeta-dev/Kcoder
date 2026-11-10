import { MigrationProjectSources } from './MigrationProjectSources';
import { MigrationInitialResourceForm } from './MigrationInitialResourceForm';
import { MigrationStandaloneHistoryCreate } from './MigrationStandaloneHistoryCreate';
import { createInitialResourceDraft, initialResourceSelection } from '../../../../../../shared/migrationInitialResourceLimits';
import { MigrationHistoryGroups } from './MigrationHistoryGroups';
import { MigrationHistoryFamilySources } from './MigrationHistoryFamilySources';
import { MigrationCodexLayerReport } from "./MigrationCodexLayerReport";
import { MigrationConfigurationLayers } from "./MigrationConfigurationLayers";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup, SettingsRow } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { migrationRequestId, type MobileMigrationClient, type MigrationSourceKind, type MigrationSourceSummary, type MigrationHistorySourcesResult, type MigrationBatchHistorySource, type MigrationBatchPluginSource, type MigrationPluginCandidate, type MigrationCalls, type MigrationJobReadResult } from "@/runtime/migration-client";
import { makeStyles, PageControls, ReadNotice, appendPage } from "../migration-result-ui";
import { useMigrationAction } from "./useMigrationAction";
import { Check, MigrationProblem } from "./WorkbenchUi";
import { MigrationPluginRecord } from "./MigrationPluginRecord";
import { MigrationMemorySources } from '../memory/MigrationMemorySources';

export function MigrationSources({ client, onJob, initialPlugin, onHistory }: { client: MobileMigrationClient; onJob(job: MigrationJobReadResult): void; initialPlugin?: MigrationBatchPluginSource; onHistory?(id: string): void }) {
  const [source, setSource] = useState<MigrationSourceKind | null>(null);
  return <SettingsGroup title={t("migration_workbench.new")} testID="migration-sources">
    <View>{(["claude-code", "codex"] as const).map(kind => <Button key={kind} testID={`migration-source-${kind}`} variant={source === kind ? "secondary" : "ghost"} onPress={() => setSource(kind)}>{kind === "claude-code" ? "Claude Code" : "Codex"}</Button>)}</View>
    {source || initialPlugin ? <SelectedSources key={source ?? initialPlugin?.operationId} source={source} client={client} onJob={onJob} initialPlugin={initialPlugin} onHistory={onHistory}/> : null}
  </SettingsGroup>;
}
function SelectedSources({ source, client, onJob, initialPlugin, onHistory }: { source: MigrationSourceKind | null; client: MobileMigrationClient; onJob(job: MigrationJobReadResult): void; initialPlugin?: MigrationBatchPluginSource; onHistory?(id: string): void }) {
  const [initialResources, setInitialResources] = useState(createInitialResourceDraft);
  const initialSelection = initialResourceSelection(initialResources);
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const [discovered, setDiscovered] = useState<MigrationCalls["discover"][1] | null>(null);
  const [sourcePage, setSourcePage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<MigrationHistorySourcesResult | null>(null);
  const [historyPages, setHistoryPages] = useState<Array<string | null>>([null]);
  const [historySelected, setHistorySelected] = useState<Record<string, MigrationBatchHistorySource>>({});
  const [plugins, setPlugins] = useState<MigrationCalls["pluginDiscover"][1] | null>(null);
  const [pluginPages, setPluginPages] = useState<Array<string | null>>([null]);
  const [copies, setCopies] = useState<Record<string, MigrationBatchPluginSource>>(initialPlugin ? { [initialPlugin.operationId]: initialPlugin } : {});
  const [pluginMappingOwner, setPluginMappingOwner] = useState<MobileMigrationClient | null>(null);
  const mapPluginProject = pluginMappingOwner === client && client.available();
  const setMapPluginProject = (enabled: boolean) => setPluginMappingOwner(enabled ? client : null);
  const [candidate, setCandidate] = useState<MigrationPluginCandidate | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [includeProject, setIncludeProject] = useState(false);
  const [memorySelected, setMemorySelected] = useState<string[]>([]), [memoryIncomplete, setMemoryIncomplete] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [familyReset, setFamilyReset] = useState(0), [familyBusy, setFamilyBusy] = useState(false);
  const [family, setFamily] = useState<{ client: MobileMigrationClient; resetKey: number; sources: MigrationBatchHistorySource[]; incomplete: boolean } | null>(null);
  const familyCurrent = family?.client === client && family.resetKey === familyReset && client.available();
  const familySelected = familyCurrent ? family.sources : [];
  const allHistory = [...Object.values(historySelected), ...familySelected];
  const count = selected.length + memorySelected.length + allHistory.length + Object.keys(copies).length;
  const incomplete = !!(familyCurrent && family.incomplete) || memoryIncomplete || !!discovered?.problems?.length || history?.discoveryComplete === false || !!history?.problems.length || !!plugins?.problems.length;
  function toggleSource(row: MigrationSourceSummary) { setSelected(ids => ids.includes(row.sourceId) ? ids.filter(id => id !== row.sourceId) : count < 64 ? [...ids, row.sourceId] : ids); }
  function historyPage(cursor: string | null, pages: Array<string | null>) {
    if (!history) return;
    void action.run(() => client.call("historySources", { catalogId: history.catalogId, cursor }), value => { setHistory(value); setHistoryPages(pages); });
  }
  function pluginPage(cursor: string | null, pages: Array<string | null>) {
    if (!source) return;
    void action.run(() => client.call("pluginDiscover", { sources: [source], cursor, ...(includeProject ? { includeProject: true } : {}) }), value => { setPlugins(value); setPluginPages(pages); });
  }
  return <View style={styles.stack}>
    <Text style={styles.note}>{t("migration_workbench.target_sources")}</Text>
    <MigrationProblem code={action.error}/>
    <ReadNotice loading={action.busy}/>
    {source ? <Check testID="migration-include-project" checked={includeProject} disabled={action.busy || discovered !== null} onPress={() => setIncludeProject(value => !value)} label={t("migration_workbench.include_project")}/> : null}
    {source ? <View style={styles.actions}>
      <Button testID="migration-discover-config" disabled={action.busy || !client.supports("discover")} onPress={() => { setSelected([]); setPartial(false); void action.run(() => client.call("discover", { sources: [source], includeProject }), value => { setDiscovered(value); setSourcePage(0); }); }}>{t("migration_workbench.discover_config")}</Button>
      <Button testID="migration-discover-history" disabled={action.busy || !client.supports("historyDiscover") || !client.supportsCapability("migrationBatchWorkersV1")} onPress={() => { setFamilyReset(value => value + 1); setFamily(null); setHistorySelected({}); setPartial(false); void action.run(() => client.call("historyDiscover", { source }), value => { setHistory(value); setHistoryPages([null]); }); }}>{t("migration_workbench.discover_history")}</Button>
      <Button testID="migration-discover-plugins" disabled={action.busy || !client.supports("pluginDiscover") || !client.supportsCapability("migrationBatchPluginsV1")} onPress={() => { setCandidate(null); setOperation(null); setPartial(false); pluginPage(null, [null]); }}>{t("migration_workbench.discover_plugins")}</Button>
    </View> : null}
    {source === 'codex' ? <MigrationHistoryFamilySources client={client} available={64 - count} disabled={action.busy} resetKey={familyReset}
      onStart={() => { setHistory(null); setHistorySelected({}); setPartial(false); }} onSelection={setFamily} onBusy={setFamilyBusy}/> : null}
    {source ? <MigrationProjectSources client={client} source={source} onJob={onJob}/> : null}
    {source && client.supports('memoryDiscover') ? <MigrationMemorySources client={client} source={source} available={64 - count} onBusy={setMemoryBusy} onSelection={(ids, partial) => { setMemorySelected(ids); setMemoryIncomplete(partial); }}/> : null}
    {discovered ? <View testID="migration-config-sources">
      <Text style={styles.title}>{t("migration_workbench.config_sources")}</Text>
      {discovered.sources.slice(sourcePage * 10, sourcePage * 10 + 10).map(row => <View key={row.sourceId} testID={`migration-source-row-${row.sourceId}`}><Check testID={`migration-config-source-${row.sourceId}`} label={`${row.displayName} · ${row.scope === "codex-project-layers" ? t("migration_codex.scope") : row.scope}`} checked={selected.includes(row.sourceId)} disabled={action.busy} onPress={() => toggleSource(row)}/>{row.kind === "codex" && row.scope === "user" && includeProject && client.supports("codexLayersSelect") ? <Button testID={`migration-codex-merge-${row.sourceId}`} variant="ghost" disabled={action.busy} onPress={() => { void action.run(() => client.call("codexLayersSelect", { sourceId: row.sourceId, includeProject: true }), value => { if (new Set([value.source.sourceId, ...selected.filter(id => !value.replacesSourceIds.includes(id))]).size + memorySelected.length + allHistory.length + Object.keys(copies).length > 64) throw new Error("migration_batch_budget_exceeded"); setDiscovered(old => old ? { ...old, sources: [value.source, ...old.sources.filter(source => source.sourceId !== value.source.sourceId)] } : old); setSelected(old => [value.source.sourceId, ...old.filter(id => !value.replacesSourceIds.includes(id))]); setSourcePage(0); }); }}>{t("migration_codex.merge")}</Button> : null}{row.scope === "codex-project-layers" ? <><Text style={styles.note}>{t("migration_codex.replacement")}</Text><MigrationCodexLayerReport client={client} target={{kind:"source",sourceId:row.sourceId}}/></> : null}{row.scope === "project-effective" ? <MigrationConfigurationLayers client={client} target={{ kind: "source", sourceId: row.sourceId }}/> : null}</View>)}
      {discovered.problems?.map((problem, i) => <Text key={i} style={styles.warning}>{problem.code}</Text>)}
      <PageControls previous={sourcePage > 0 && !action.busy} next={(sourcePage + 1) * 10 < discovered.sources.length && !action.busy} onPrevious={() => setSourcePage(p => p - 1)} onNext={() => setSourcePage(p => p + 1)}/>
    </View> : null}
    {history ? <View testID="migration-history-sources">
      <Text style={styles.title}>{t("migration_workbench.history_sources")}</Text>
      <MigrationHistoryGroups items={history.items}>{row => <View testID={`migration-history-selection-${row.sourceHandle}`} key={row.sourceHandle}><Check testID={`migration-history-source-${row.sourceHandle}`} label={row.title || row.sourceSessionId} checked={!!historySelected[row.sourceHandle]} disabled={action.busy || row.importIssues.length > 0 || !historySelected[row.sourceHandle] && count >= 64} onPress={() => setHistorySelected(old => { const next = { ...old }; if (next[row.sourceHandle]) delete next[row.sourceHandle]; else if (count < 64) next[row.sourceHandle] = { catalogId: history.catalogId, sourceHandle: row.sourceHandle }; return next; })}/>{row.importIssues.map((code, i) => <Text key={i} style={styles.warning}>{code}</Text>)}{onHistory ? <MigrationStandaloneHistoryCreate key={row.sourceHandle} client={client} catalogId={history.catalogId} sourceHandle={row.sourceHandle} resourceLimits={initialSelection.limits} disabled={action.busy || !initialSelection.valid || row.importIssues.length > 0} onCreated={onHistory}/> : null}</View>}</MigrationHistoryGroups>
      {history.problems.map((problem, i) => <Text key={i} style={styles.warning}>{problem.code} · {problem.count}</Text>)}
      <PageControls previous={historyPages.length > 1 && !action.busy} next={!!history.nextCursor && !action.busy} onPrevious={() => { const pages = historyPages.slice(0, -1); historyPage(pages.at(-1) ?? null, pages); }} onNext={() => { if (history.nextCursor) historyPage(history.nextCursor, appendPage(historyPages, history.nextCursor)); }}/>
    </View> : null}
    {plugins ? <View testID="migration-plugin-sources">
      <Text style={styles.title}>{t("migration_workbench.plugin_sources")}</Text>
      {plugins.candidates.map(row => <SettingsRow key={row.candidateId} testID={`migration-plugin-candidate-${row.candidateId}`} label={row.name} note={`${row.installedVersion ?? "—"} · ${row.scope} · ${row.pending.join(", ")}`} onPress={() => { setCandidate(row); setOperation(null); setMapPluginProject(false); }}/>) }
      {plugins.problems.map((problem, i) => <Text key={i} style={styles.warning}>{problem.code}</Text>)}
      <PageControls previous={pluginPages.length > 1 && !action.busy} next={!!plugins.nextCursor && !action.busy} onPrevious={() => { const pages = pluginPages.slice(0, -1); pluginPage(pages.at(-1) ?? null, pages); }} onNext={() => { if (plugins.nextCursor) pluginPage(plugins.nextCursor, appendPage(pluginPages, plugins.nextCursor)); }}/>
    </View> : null}
    {candidate ? <View style={styles.stack}>
      <Text style={styles.title}>{candidate.name} · {candidate.installedVersion ?? "—"} · {candidate.scope}</Text>
      <Text style={styles.note}>{t("migration_workbench.plugin_static_note")}</Text>
      {candidate.pending.map((code, i) => <Text key={i} style={styles.warning}>{code}</Text>)}
      {['project', 'local'].includes(candidate.scope) ? <Check testID="migration-plugin-map-workspace" checked={mapPluginProject} disabled={action.busy || !client.workspaceAvailable()} onPress={() => setMapPluginProject(!mapPluginProject)} label={t('migration_workbench.plugin_project_map')}/> : null}
      {!operation ? <Button testID="migration-plugin-prepare" disabled={action.busy || candidate.pending.some(code => code !== 'plugin_project_mapping_required') || candidate.scope !== "user" && (!['project', 'local'].includes(candidate.scope) || !mapPluginProject || !client.workspaceAvailable())} onPress={() => { const requestId = migrationRequestId(); setOperation(requestId); void action.run(() => client.call("pluginPlan", { requestId, candidateId: candidate.candidateId, ...(mapPluginProject && candidate.scope !== "user" ? { projectMapping: "current_workspace" as const } : {}) })); }}>{t("migration_workbench.prepare_copy")}</Button> : !action.busy ? <MigrationPluginRecord key={operation} client={client} operationId={operation} onUse={binding => { if (count < 64 || copies[binding.operationId]) setCopies(old => ({ ...old, [binding.operationId]: binding })); }} onBatch={id => { void action.run(() => client.call("batchRead", { jobId: id }), value => onJob(value.state)); }}/> : null}
    </View> : null}
    {Object.values(copies).map(binding => <Button key={binding.operationId} testID={`migration-plugin-selected-${binding.operationId}`} variant="ghost" onPress={() => setCopies(old => { const next = { ...old }; delete next[binding.operationId]; return next; })}>{t("migration_workbench.remove_copy", { id: binding.operationId })}</Button>)}
    {incomplete ? <Check testID="migration-partial-consent" checked={partial} onPress={() => setPartial(value => !value)} label={t("migration_workbench.partial_consent")}/> : null}
    <Text style={styles.note}>{t("migration_workbench.selected_sources", { count })}</Text>
    <MigrationInitialResourceForm draft={initialResources} onChange={setInitialResources} disabled={action.busy || memoryBusy || familyBusy}/>
    <Button testID="migration-scan-selection" variant="primary" disabled={action.busy || memoryBusy || familyBusy || !initialSelection.valid || count === 0 || count > 64 || incomplete && !partial || !client.supports("scan")} onPress={() => { void action.run(() => client.call("scan", { ...(initialSelection.limits ? { resourceLimits: initialSelection.limits } : {}), sourceIds: [...selected, ...memorySelected], ...(allHistory.length ? { historySources: allHistory } : {}), ...(Object.keys(copies).length ? { pluginSources: Object.values(copies) } : {}) }), onJob); }}>{t("migration_workbench.scan_selected")}</Button>
  </View>;
}
