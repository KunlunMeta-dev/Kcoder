import { ProjectTargetCatalogCache } from '../../../../../../shared/migrationProjectMapping';
import { MigrationCodexLayerReport } from "./MigrationCodexLayerReport";
import { MigrationConfigurationLayers } from "./MigrationConfigurationLayers";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient, MigrationItemsResult, MigrationJobReadResult } from "@/runtime/migration-client";
import { makeStyles, PageControls } from "../migration-result-ui";
import { useMigrationAction } from "./useMigrationAction";
import { Check, MigrationProblem } from "./WorkbenchUi";
import { MigrationItemEditor, type ItemSelection } from "./MigrationItemEditor";
import { MigrationProjectMcpPicker, useProjectMcpCatalog } from './MigrationProjectMcpPicker';

export function MigrationBatchEditor({ client, job, onPreview }: { client: MobileMigrationClient; job: MigrationJobReadResult; onPreview(job: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const projectMcp = useProjectMcpCatalog(client, job.job.jobId);
  const projectCatalog = useMemo(() => new ProjectTargetCatalogCache(JSON.stringify([job.job.jobId, client.workspaceAvailable()])), [client, job.job.jobId]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<MigrationItemsResult | null>(null);
  const [choices, setChoices] = useState<Record<string, ItemSelection>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [reuse, setReuse] = useState(false);
  useEffect(() => { void action.run(() => client.call("items", { jobId: job.job.jobId, pageIndex, includeTemplates: client.supportsCapability("migrationTemplatesV1") }), setPage); }, [client, job.job.jobId, job.job.sequence, pageIndex]);
  return <SettingsGroup title={t("migration_workbench.items")} testID="migration-batch-editor">
    <MigrationProblem code={action.error}/>
    <Text style={styles.note}>{t("migration_workbench.explicit_items")}</Text>
    {editing && page ? <MigrationItemEditor projectCatalog={projectCatalog} key={editing} client={client} jobId={job.job.jobId} page={page} itemId={editing} choices={Object.values(choices)} initial={choices[editing]} onClose={() => setEditing(null)} onSave={value => { setChoices(old => ({ ...old, [editing]: value })); setEditing(null); }}/> : <>
      {page?.items.map(row => <View key={row.id} style={styles.row}>
        {["provider", "mcp"].includes(row.category) ? job.source === "codex" ? <MigrationCodexLayerReport client={client} target={{kind:"job",jobId:job.job.jobId,itemId:row.id}}/> : <MigrationConfigurationLayers client={client} target={{ kind: "job", jobId: job.job.jobId, itemId: row.id }}/> : null}
        <Text style={styles.title}>{row.sourceName}</Text><Text style={styles.note}>{row.category} · {t(`migration_results.item_${row.status}`)}</Text>
        <View style={styles.actions}><Button testID={`migration-item-edit-${row.id}`} variant="ghost" disabled={action.busy} onPress={() => setEditing(row.id)}>{t(choices[row.id] ? "migration_workbench.edit_selected" : "migration_workbench.review_select")}</Button>{choices[row.id] ? <Button testID={`migration-item-remove-${row.id}`} variant="ghost" onPress={() => setChoices(old => { const next = { ...old }; delete next[row.id]; return next; })}>{t("migration_workbench.remove")}</Button> : null}</View>
      </View>)}
      <PageControls previous={pageIndex > 0 && !action.busy} next={!!page?.nextCursor && !action.busy} onPrevious={() => { setPage(null); setPageIndex(value => value - 1); }} onNext={() => { setPage(null); setPageIndex(value => value + 1); }}/>
      {client.supportsCapability("migrationReuseV1") ? <Check testID="migration-reuse" checked={reuse} onPress={() => setReuse(value => !value)} label={t("migration_workbench.reuse")}/> : null}
      <Text style={styles.note}>{t("migration_workbench.selected_items", { count: Object.keys(choices).length })}</Text>
      <MigrationProjectMcpPicker {...projectMcp} disabled={action.busy}/>
      <Button testID="migration-preview-plan" variant="primary" disabled={action.busy || !Object.keys(choices).length} onPress={() => { const rows = Object.values(choices); void action.run(() => client.call("plan", { jobId: job.job.jobId, expectedSequence: job.job.sequence, choices: rows.map(row => row.choice), includeDefaultItems: false, excludedItemIds: [], reuseExisting: reuse, ...(projectMcp.controller.selection() ? { projectMcpInheritance: projectMcp.controller.selection() } : {}), ...(rows.some(row => row.credential) ? { credentials: rows.flatMap(row => row.credential ? [row.credential] : []) } : {}), ...(rows.some(row => row.mcpCredential) ? { mcpCredentials: rows.flatMap(row => row.mcpCredential ? [row.mcpCredential] : []) } : {}) }), onPreview); }}>{t("migration_workbench.preview")}</Button>
    </>}
  </SettingsGroup>;
}
