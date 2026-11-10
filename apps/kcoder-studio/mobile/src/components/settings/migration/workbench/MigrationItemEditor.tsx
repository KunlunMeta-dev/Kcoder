import type { ProjectTargetCatalogCache } from '../../../../../../shared/migrationProjectMapping';
import { MigrationProjectMapping } from './MigrationProjectMapping';
import { MigrationAgentChoice } from './MigrationAgentChoice';
import type { MigrationAgentAdaptation } from '../../../../../../shared/generated/contracts';
import { MigrationJobInstructionPreview } from './MigrationJobInstructionPreview';
import { MigrationDefinitionPreview } from '../source/MigrationDefinitionPreview';
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Button, Field } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient, MigrationItemsResult, MigrationBatchChoice, MigrationBatchCredentialChoice, MigrationBatchMcpCredentialChoice } from "@/runtime/migration-client";
import { makeStyles, PageControls } from "../migration-result-ui";
import { MigrationIssues } from "../MigrationIssues";
import { Check, MigrationProblem } from "./WorkbenchUi";
import { MigrationAssetPreview } from "./MigrationAssetPreview";

export interface ItemSelection { choice: MigrationBatchChoice; credential?: MigrationBatchCredentialChoice; mcpCredential?: MigrationBatchMcpCredentialChoice }
export function MigrationItemEditor({ client, jobId, page, itemId, choices, initial, onSave, onClose, projectCatalog }: { projectCatalog?: ProjectTargetCatalogCache; client: MobileMigrationClient; jobId: string; page: MigrationItemsResult; itemId: string; choices: ItemSelection[]; initial?: ItemSelection; onSave(value: ItemSelection): void; onClose(): void }) {
  const styles = useThemedStyles(makeStyles);
  const item = page.items.find(row => row.id === itemId)!;
  const proposed = initial?.choice ?? page.drafts?.find(row => row.itemId === itemId)?.choice;
  const template = page.templates?.find(row => row.itemId === itemId);
  const provider = page.providers?.find(row => row.itemId === itemId);
  const mcp = page.mcps?.find(row => row.itemId === itemId);
  const draftName = page.drafts?.find(row => row.itemId === itemId)?.targetName;
  const [name, setName] = useState(proposed && "targetName" in proposed ? proposed.targetName : draftName ?? "");
  const [endpoint, setEndpoint] = useState(proposed?.kind === "provider" ? proposed.endpoint ?? "" : provider?.endpoint ?? "");
  const [model, setModel] = useState(proposed?.kind === "provider" ? proposed.model ?? "" : provider?.model ?? "");
  const [context, setContext] = useState(String(proposed?.kind === "provider" ? proposed.contextWindowTokens : provider?.contextWindowTokens ?? ""));
  const [headroom, setHeadroom] = useState(String(proposed?.kind === "provider" ? proposed.outputHeadroomTokens : provider?.outputHeadroomTokens ?? ""));
  const [output, setOutput] = useState(String(proposed?.kind === "provider" ? proposed.maxOutputTokens : provider?.maxOutputTokens ?? ""));
  const [cwd, setCwd] = useState(proposed?.kind === "mcp" ? proposed.cwd ?? "" : mcp?.cwd ?? "");
  const [enabled, setEnabled] = useState(proposed && "enableAfterImport" in proposed ? proposed.enableAfterImport ?? false : false);
  const [providerItem, setProviderItem] = useState(proposed?.kind === "template" ? proposed.providerItemId : template?.providerItemId ?? "");
  const [credential, setCredential] = useState<"configuration" | "environment" | null>(initial?.credential?.source ?? null);
  const [privateFields, setPrivateFields] = useState(initial?.mcpCredential?.fields ?? []);
  const [privatePage, setPrivatePage] = useState(0);
  const isMemory = item.category === 'memory';
  const definition = item.category === 'agent' || item.category === 'hook';
  const [agentSelection, setAgentSelection] = useState<{ value: MigrationAgentAdaptation | null; ready: boolean }>({ value: null, ready: !proposed || proposed.kind !== 'asset' || !proposed.agentAdaptation });
  const agentChanged = useCallback((value: MigrationAgentAdaptation | null, ready: boolean) => setAgentSelection(old => old.ready === ready && JSON.stringify(old.value) === JSON.stringify(value) ? old : { value, ready }), []);
  const [memoryMapping, setMemoryMapping] = useState<'global' | 'current_workspace' | null>(proposed?.kind === 'asset' ? proposed.memoryMapping ?? null : null);
  // An absent default is not unsupported: required values may need an explicit user mapping.
  const kind: MigrationBatchChoice["kind"] | undefined = proposed?.kind ?? (provider ? "provider" : mcp ? "mcp" : template ? "template" : page.assets?.some(row => row.itemId === itemId) ? "asset" : undefined);
  const supported = kind !== undefined && client.supportsChoice(kind) && (!['agent', 'hook'].includes(item.category) || client.supportsCapability('migrationDefinitionsV1'));
  const fields = mcp ? [...mcp.requiredEnv.map(name => ({ kind: "environment" as const, name })), ...mcp.requiredHeaders.map(name => ({ kind: "header" as const, name }))] : [];
  const numbers = [context, headroom, output].map(value => /^\d+$/.test(value) ? Number(value) : NaN);
  const valid = supported && agentSelection.ready && (!isMemory || client.supportsCapability('migrationMemoryV1') && !!memoryMapping && (memoryMapping !== 'current_workspace' || client.workspaceAvailable())) && (kind === "history" || /^[A-Za-z0-9._-]{1,128}$/.test(name)) && (kind !== "provider" || !!model.trim() && numbers.every(Number.isSafeInteger) && numbers[0] > 0 && numbers[1] >= 0 && numbers[2] > 0) && (kind !== "template" || !!providerItem);
  function save() {
    if (!valid || !kind) return;
    let choice: MigrationBatchChoice;
    switch (kind) {
      case "project": return;
      case "history": choice = { kind, itemId }; break;
      case "plugin": choice = { kind, itemId, targetName: name }; break;
      case "template": choice = { kind, itemId, targetName: name, providerItemId: providerItem }; break;
      case "mcp": choice = { kind, itemId, targetName: name, cwd: cwd.trim() || null, enableAfterImport: enabled }; break;
      case "asset": choice = { kind, itemId, targetName: name, enableAfterImport: isMemory || definition ? false : enabled, ...(isMemory && memoryMapping ? { memoryMapping } : {}), ...(item.category === 'agent' && agentSelection.value ? { agentAdaptation: agentSelection.value } : {}) }; break;
      case "provider": choice = { kind, itemId, targetName: name, endpoint: endpoint.trim() || null, model: model.trim(), contextWindowTokens: numbers[0], outputHeadroomTokens: numbers[1], maxOutputTokens: numbers[2] }; break;
    }
    onSave({ choice, ...(credential ? { credential: { itemId, source: credential, consentApiKey: true } } : {}), ...(privateFields.length ? { mcpCredential: { itemId, fields: privateFields, consentPrivateValues: true } } : {}) });
  }
  if (item.category === 'project') return <MigrationProjectMapping catalog={projectCatalog} client={client} jobId={jobId} itemId={itemId} onSave={choice => onSave({ choice })} onClose={onClose}/>;
  return <View style={styles.stack} testID="migration-item-editor">
    {definition ? <><Text style={styles.warning}>{t('migration_definitions.enable_unavailable')}</Text><Text style={styles.note}>{t(client.supportsCapability('migrationDefinitionsV1') ? 'migration_definitions.no_plan' : 'migration_definitions.update_required')}</Text><MigrationDefinitionPreview client={client} jobId={jobId} itemId={itemId}/></> : null}
    {item.category === 'agent' ? <MigrationAgentChoice client={client} jobId={jobId} itemId={itemId} initial={proposed?.kind === 'asset' ? proposed.agentAdaptation : null} onChange={agentChanged}/> : null}
    <Text style={styles.title}>{item.sourceName}</Text><Text style={styles.note}>{item.category}</Text>
    <MigrationIssues issues={item.issues}/>
    {page.assets?.some(row => row.itemId === itemId) && client.supports("assetPreview") ? <MigrationAssetPreview client={client} jobId={jobId} itemId={itemId}/> : null}
    {item.category === 'instructions' && client.supports('instructionBody') ? <MigrationJobInstructionPreview client={client} jobId={jobId} itemId={itemId}/> : null}
    {!supported ? kind ? <MigrationProblem code="migration_update_required"/> : <Text style={styles.warning}>{t("migration_workbench.unsupported_item")}</Text> : <>
      {kind !== "history" ? <Field testID="migration-item-name" label={t(kind === "plugin" ? "migration_workbench.install_name" : "migration_workbench.target_name")} value={name} onChangeText={setName} maxLength={128} autoCapitalize="none" autoCorrect={false}/> : null}
      {kind === "provider" ? <>
        <Field testID="migration-provider-endpoint" label={t("migration_workbench.endpoint")} value={endpoint} onChangeText={setEndpoint} autoCapitalize="none" autoCorrect={false}/>
        <Field testID="migration-provider-model" label={t("migration_workbench.model")} value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false}/>
        <Field testID="migration-provider-context" label={t("migration_workbench.context")} value={context} onChangeText={setContext} keyboardType="numeric"/>
        <Field testID="migration-provider-headroom" label={t("migration_workbench.headroom")} value={headroom} onChangeText={setHeadroom} keyboardType="numeric"/>
        <Field testID="migration-provider-output" label={t("migration_workbench.output")} value={output} onChangeText={setOutput} keyboardType="numeric"/>
        <Text style={styles.note}>{t("migration_workbench.credential_note")}</Text>
        {client.supportsCapability("migrationBatchCredentialsV1") ? <View style={styles.actions}>{([null, "configuration", "environment"] as const).map(source => <Button key={String(source)} testID={`migration-credential-${source ?? "none"}`} variant={source === credential ? "secondary" : "ghost"} onPress={() => setCredential(source)}>{t(`migration_workbench.credential_${source ?? "none"}`)}</Button>)}</View> : null}
      </> : null}
      {kind === "mcp" ? <>
        <Field testID="migration-mcp-cwd" label={t("migration_workbench.cwd")} value={cwd} onChangeText={setCwd} autoCorrect={false} autoCapitalize="none"/>
        <Text style={styles.note}>{t("migration_workbench.credential_note")}</Text>
        <View testID="migration-mcp-private-fields">
          {fields.slice(privatePage * 10, privatePage * 10 + 10).map(field => <Check key={`${field.kind}:${field.name}`} testID={`migration-private-${field.kind}-${field.name}`} checked={privateFields.some(row => row.kind === field.kind && row.name === field.name)} disabled={!client.supportsCapability("migrationBatchMcpCredentialsV1")} label={`${field.kind}: ${field.name}`} onPress={() => setPrivateFields(old => old.some(row => row.kind === field.kind && row.name === field.name) ? old.filter(row => row.kind !== field.kind || row.name !== field.name) : [...old, field])}/>)}
          <PageControls previous={privatePage > 0} next={(privatePage + 1) * 10 < fields.length} onPrevious={() => setPrivatePage(value => value - 1)} onNext={() => setPrivatePage(value => value + 1)}/>
          <Text style={styles.note}>{t("migration_workbench.private_fields_selected", { count: privateFields.length })}</Text>
        </View>
      </> : null}
      {kind === "template" ? <View><Text style={styles.note}>{t("migration_workbench.template_provider")}</Text>{choices.filter(row => row.choice.kind === "provider").map(row => <Button key={row.choice.itemId} testID={`migration-template-provider-${row.choice.itemId}`} variant={providerItem === row.choice.itemId ? "secondary" : "ghost"} onPress={() => setProviderItem(row.choice.itemId)}>{"targetName" in row.choice ? row.choice.targetName : row.choice.itemId}</Button>)}{providerItem ? <Text selectable style={styles.note}>{providerItem}</Text> : null}</View> : null}
      {isMemory ? <View><Text style={styles.warning}>{t('migration_memory.mapping_note')}</Text><View style={styles.actions}>{(['global', 'current_workspace'] as const).map(value => <Button key={value} testID={`migration-memory-map-${value}`} disabled={value === 'current_workspace' && !client.workspaceAvailable()} variant={value === memoryMapping ? 'secondary' : 'ghost'} onPress={() => setMemoryMapping(value)}>{t(`migration_memory.mapping_${value}`)}</Button>)}</View>{!client.workspaceAvailable() ? <Text style={styles.note}>{t('migration_memory.no_workspace')}</Text> : null}</View> : (kind === "asset" || kind === "mcp") && !definition ? <Check testID="migration-item-enable" checked={enabled} onPress={() => setEnabled(value => !value)} label={t("migration_workbench.enable_after")}/> : null}
      {kind === "plugin" ? <Text style={styles.note}>{t("migration_workbench.plugin_static_note")}</Text> : null}
      <Button testID="migration-item-save" disabled={!valid} onPress={save}>{t("migration_workbench.select_item")}</Button>
    </>}
    <Button testID="migration-item-close" variant="ghost" onPress={onClose}>{t("migration_workbench.dismiss")}</Button>
  </View>;
}
