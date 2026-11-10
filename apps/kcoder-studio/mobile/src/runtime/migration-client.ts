import { BatchCancellationControl, batchControlMethod, BATCH_CONTROL_CAPABILITY, validBatchControlCall } from '../../../shared/migrationBatchControl';
import { resourceAttachmentMethod, validResourceAttachment } from '../../../shared/migrationResourceAttachment';
import { PROJECTS_METHODS, validProjectCall } from '../../../shared/migrationProjects';
import { historyResourceMethod, validHistoryResourceCall } from '../../../shared/migrationHistoryResourceBudget';
import { AGENT_PREVIEW_METHOD, AGENT_CAPABILITY, hasAgentAdaptations, validAgentPreview } from '../../../shared/migrationAgents';
import { INSTRUCTION_METHODS, validInstructionCall } from '../../../shared/migrationInstructions.mjs';
import { PROJECT_MCP_METHOD, PROJECT_MCP_CAPABILITY, validProjectMcpCatalog } from '../../../shared/migrationProjectMcp';
import { validResourceCall, RESOURCE_BUDGET_CAPABILITY } from '../../../shared/migrationResourceBudget';
import { CREDENTIAL_SOURCES_METHOD, validCredentialSources } from '../../../shared/migrationCredentialSources';
import { isPrivateCredentialError } from '../../../shared/migrationPrivateCredentials';
import { validDefinitionCall } from '../../../shared/migrationDefinitions';
import { validCodexLayerReport, validCodexLayerSelection } from "../../../shared/migrationCodexLayers";
import type { MigrationCodexLayersSelectParams, MigrationCodexLayersSelectResult, MigrationConfigurationLayersParams as CodexReportParams, MigrationCodexLayersReadResult } from "../../../shared/generated/contracts";
import { validConfigurationLayers } from "../../../shared/migrationConfigurationLayers";
import type { MigrationConfigurationLayersParams, MigrationConfigurationLayersResult } from "../../../shared/generated/contracts";
import { CALLS, type MigrationCalls } from "./migration-client/contracts";
import type { MigrationIntent, MigrationIntentStore } from "@/storage/migration-intents";
import { validHistoricalResult } from "./migration-client/history-validation";
import { validMemoryResult } from './migration-client/memory-contracts';
import { validSourceUploadResult } from './migration-client/source-upload-contracts';
import { validHistoryLifecycleResult } from '../../../shared/migrationHistoryLifecycle';
export * from "./migration-client/contracts";
const CHOICE_CAPABILITIES: Record<string, string> = { project: "migrationProjectsV1", plugin: "migrationBatchPluginsV1", template: "migrationTemplatesV1", history: "migrationBatchWorkersV1", provider: "migrationProvidersV1", mcp: "migrationMcpV1", asset: "migrationAssetsV1" };
export class MobileMigrationError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function migrationError(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (isPrivateCredentialError(text)) return text;
  return text.match(/\b(?:migration|source_upload|source_transfer|plugin_migration|history|continuation|historical_projection|historical_context|historical_seed|historical_undo|external_history|local_upload|local_attachment)_[a-z_]{1,120}\b/)?.[0] ?? "migration_request_failed";
}
/** A correlation nonce is not an authorization grant; the Native target owns every operation. */
export function migrationRequestId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, letter => {
    const n = Math.floor(Math.random() * 16);
    return (letter === "x" ? n : (n & 3) | 8).toString(16);
  });
}
export class MobileMigrationClient {
  private active = true;
  private readonly batchCancellation = new BatchCancellationControl(migrationRequestId);
  private readonly viewHolds = new Map<string,string>();
  private readonly viewBindings = new Map<string,string>();
  private readonly mutations = new Set<string>();
  constructor(
    private readonly request: (method: string, params: unknown) => Promise<unknown>,
    private readonly capabilities: Readonly<Record<string, boolean>>,
    private readonly journal: MigrationIntentStore,
    private readonly current: () => boolean,
    private readonly workspacePath?: string,
  ) {}
  workspaceAvailable(): boolean { return !!this.workspacePath?.trim(); }
  available(): boolean { return this.active && this.current(); }
  private releaseView(requestId:string,leaseId:string):void {
    try { void this.request('migration/history/view/release',{requestId,leaseId}).catch(()=>undefined); } catch { /* The original transport may already be unavailable. */ }
  }
  close(): void {
    this.active = false;
    for(const [requestId,leaseId] of this.viewHolds) this.releaseView(requestId,leaseId);
    this.viewHolds.clear();
  }
  supports(name: keyof MigrationCalls): boolean { return CALLS[name].caps.every(cap => this.capabilities[cap] === true); }
  supportsCapability(cap: string): boolean { return this.capabilities[cap] === true; }
  supportsChoice(kind: string): boolean { return typeof CHOICE_CAPABILITIES[kind] === "string" && this.supportsCapability(CHOICE_CAPABILITIES[kind]); }
  async intents(): Promise<MigrationIntent[]> { this.assert(); const rows = await this.journal.read(); this.assert(); return rows; }
  async continuationIntent(sourceJobId: string, viewId: string, familyDigest: string): Promise<{ intent: MigrationIntent; created: boolean }> {
    this.assert();
    if (!/^[a-f0-9]{64}$/.test(familyDigest) || !this.journal.reserveFamily) throw new MobileMigrationError("migration_recovery_storage_unavailable");
    const requestId = migrationRequestId();
    const candidate: MigrationIntent = { id: requestId, requestId, jobId: requestId, sourceJobId, viewId, familyDigest, method: "migration/history/continuation/create", createdAt: Date.now(), phase: "intent" };
    const intent = await this.journal.reserveFamily(candidate); this.assert();
    return { intent, created: intent.id === candidate.id };
  }
  /** Explicit local bookkeeping never changes or proves the target-side operation outcome. */
  async archiveLocator(id: string, confirmation: string): Promise<void> {
    this.assert();
    if (confirmation !== "ARCHIVE") throw new MobileMigrationError("migration_explicit_confirmation_required");
    const row = (await this.intents()).find(value => value.id === id);
    if (!row) throw new MobileMigrationError("migration_recovery_record_missing");
    this.assert(); await this.journal.put({ ...row, phase: "reviewed" }); this.assert();
  }
  /** Refresh a CAS watermark after confirmation; the confirmed target and frozen plan cannot change. */
  async operateBatch(jobId: string, planId: string, mode: "apply" | "resume" | "rollback" | "cancel", requestId: string): Promise<MigrationCalls["batchRead"][1]> {
    const fresh = await this.call("batchRead", { jobId });
    if (fresh.state.batch?.planId !== planId) throw new MobileMigrationError("migration_plan_changed");
    if (mode === "cancel" && !fresh.workerRunning) return fresh;
    if (mode !== "cancel" && fresh.workerRunning) throw new MobileMigrationError("migration_worker_running");
    if (mode === "resume" && (["completed", "rolled_back"].includes(fresh.state.job.status) || fresh.state.job.status === "completed_with_issues" && !fresh.state.batch?.unresolvedActions)) return fresh;
    if (mode === "apply" && fresh.state.job.status !== "ready") throw new MobileMigrationError("migration_explicit_resume_required");
    if (mode === "cancel") {
      if (!this.supportsCapability(BATCH_CONTROL_CAPABILITY) && this.batchCancellation.hasPending(jobId)) throw new MobileMigrationError("migration_batch_cancel_unconfirmed");
      const controlled = this.supportsCapability(BATCH_CONTROL_CAPABILITY) && await this.batchCancellation.cancel({
        batchControlRead: input => this.call('batchControlRead', input),
        batchControlCancel: input => this.call('batchControlCancel', input),
      }, jobId, planId, () => this.assert()) !== null;
      if (!controlled) await this.call("cancel", { jobId, expectedSequence: fresh.state.job.sequence });
      return this.call("batchRead", { jobId });
    }
    return this.call("batchRun", { jobId, planId, requestId, mode, expectedSequence: fresh.state.job.sequence });
  }
  async operatePlugin(operationId: string, mode: "pluginCapture" | "pluginResume" | "pluginCancel" | "pluginUndo"): Promise<MigrationCalls["pluginRead"][1]> {
    const fresh = await this.call("pluginRead", { operationId });
    if (fresh.job.batchJobId) throw new MobileMigrationError("plugin_migration_control_owned_by_batch");
    if (fresh.workerRunning && mode !== "pluginCancel") throw new MobileMigrationError("plugin_migration_busy");
    if (mode === "pluginCapture" && fresh.job.stage === "ready") return fresh;
    return this.call(mode, { operationId, expectedSequence: fresh.job.sequence });
  }
  private assert(): void { if (!this.available()) throw new MobileMigrationError("migration_scope_changed"); }
  async call<N extends keyof MigrationCalls>(name: N, params: MigrationCalls[N][0], options?: { familyDigest?: string }): Promise<MigrationCalls[N][1]> {
    this.assert();
    const rule = CALLS[name];
    if (!this.supports(name)) throw new MobileMigrationError("migration_update_required");
    if (!rule.params(params)) throw new MobileMigrationError("migration_invalid_parameters");
    const p = params as Record<string, unknown>;
    if (batchControlMethod(rule.method) && !validBatchControlCall(rule.method, params)) throw new MobileMigrationError('migration_invalid_parameters');
    if (Object.values(PROJECTS_METHODS).some(value => value === rule.method) && !validProjectCall(rule.method, params)) throw new MobileMigrationError('migration_invalid_parameters');
    if (rule.method === PROJECT_MCP_METHOD && !validProjectMcpCatalog(params)) throw new MobileMigrationError('migration_invalid_parameters');
    if ((name === 'scan' && Array.isArray(p.projectSources) && p.projectSources.length > 0 || name === 'plan' && Array.isArray(p.choices) && p.choices.some(row => row?.kind === 'project')) && !this.supportsCapability('migrationProjectsV1')) throw new MobileMigrationError('migration_projects_update_required');
    if (name === 'plan' && hasAgentAdaptations(params) && !this.supportsCapability(AGENT_CAPABILITY)) throw new MobileMigrationError('migration_agent_update_required');
    if (rule.method === AGENT_PREVIEW_METHOD && !validAgentPreview(params)) throw new MobileMigrationError('migration_invalid_parameters');
    if (name === 'plan' && p.projectMcpInheritance != null && !this.supportsCapability(PROJECT_MCP_CAPABILITY)) throw new MobileMigrationError('migration_project_mcp_update_required');
    if (rule.method === CREDENTIAL_SOURCES_METHOD && !validCredentialSources(params)) throw new MobileMigrationError('migration_invalid_parameters');
    if (!resourceAttachmentMethod(rule.method) && rule.method !== "migration/batch/resources/attach" && rule.method.startsWith("migration/batch/resources/") && !validResourceCall(rule.method, params)) throw new MobileMigrationError("migration_invalid_parameters");
    if(rule.method.startsWith('migration/history/view/')) {
      const id=String(p.requestId), previous=this.viewBindings.get(id);
      if(name==='historyViewOpen') {
        const binding=JSON.stringify([p.jobId,p.expectedArchiveId,p.viewId??null]);
        if(previous&&previous!==binding||!previous&&this.viewBindings.size>=256) throw new MobileMigrationError('history_view_scope_changed');
        this.viewBindings.set(id,binding);
      } else if(!previous) throw new MobileMigrationError('history_view_scope_changed');
    }
    if (name === 'pluginDiscover' && p.includeUploaded === true && !this.supportsCapability('migrationSourceUploadedPluginsV1')) throw new MobileMigrationError('migration_plugins_update_required');
    if ((name === 'pluginDiscover' && p.includeProject === true || name === 'pluginPlan' && p.projectMapping !== undefined)
      && !this.supportsCapability('migrationPluginProjectsV1')) throw new MobileMigrationError('migration_plugin_projects_update_required');
    if (name === "codexLayersSelect" && p.includeProject !== true) throw new MobileMigrationError("migration_codex_project_consent_required");
    if (name === 'memoryControl' && p.enabled === true && p.confirmUnverifiedNotes !== true) throw new MobileMigrationError('migration_memory_confirmation_required');
    if (name === 'sourceUploadPart' && (typeof p.contentBase64 !== 'string' || p.contentBase64.length > Math.ceil(128 * 1024 / 3) * 4)) throw new MobileMigrationError('source_upload_part_budget_exceeded');
    if (resourceAttachmentMethod(rule.method) && !validResourceAttachment(rule.method, params)) throw new MobileMigrationError('migration_invalid_parameters');
    if (historyResourceMethod(rule.method) && !validHistoryResourceCall(rule.method, params)) throw new MobileMigrationError("migration_invalid_parameters");
    if (name === "historySearch" && (typeof p.query !== "string" || !p.query.trim() || [...p.query].length > 256 || new TextEncoder().encode(p.query).length > 1024 || p.limit != null && (!Number.isInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 10))) throw new MobileMigrationError("history_search_invalid_query");
    if (options?.familyDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.familyDigest)) throw new MobileMigrationError("migration_invalid_parameters");
    if (name === "localBegin" && (!Number.isSafeInteger(p.bytes) || Number(p.bytes) < 0 || Number(p.bytes) > 256 * 1024 * 1024)) throw new MobileMigrationError("local_upload_file_budget_exceeded");
    if (name === "localPart" && (typeof p.contentBase64 !== "string" || p.contentBase64.length > 256 * 1024)) throw new MobileMigrationError("local_upload_part_budget_exceeded");
    if (name === "continuationCreate" && Array.isArray((p.options as any)?.localAttachments) && (p.options as any).localAttachments.length && !this.supportsCapability("migrationLocalAttachmentsV1")) throw new MobileMigrationError("migration_local_attachments_update_required");
    if (name === "branchPrepare" && p.reconstructReadable === true && !this.supportsCapability("migrationHistoryReconstructionV1")) throw new MobileMigrationError("migration_history_reconstruction_update_required");
    if (name === "scan") {
      if (p.resourceLimits !== undefined && !this.supportsCapability(RESOURCE_BUDGET_CAPABILITY)) throw new MobileMigrationError("migration_resource_budget_update_required");
      if (Array.isArray(p.historySources) && p.historySources.length && !this.supportsCapability("migrationBatchWorkersV1")) throw new MobileMigrationError("migration_update_required");
      if (Array.isArray(p.pluginSources) && p.pluginSources.length && !this.supportsCapability("migrationBatchPluginsV1")) throw new MobileMigrationError("migration_plugins_update_required");
    }
    if (name === "plan") {
      for (const choice of p.choices as Array<{kind:string}>) {
        if (!this.supportsChoice(choice.kind)) throw new MobileMigrationError("migration_update_required");
        const memory = choice as { memoryMapping?: unknown; enableAfterImport?: boolean };
        if (memory.memoryMapping != null && (!this.supportsCapability('migrationMemoryV1') || memory.enableAfterImport !== false)) throw new MobileMigrationError('migration_memory_confirmation_required');
        if (memory.memoryMapping === 'current_workspace' && !this.workspaceAvailable()) throw new MobileMigrationError('migration_memory_workspace_required');
      }
      for (const [field, cap] of [["credentials", "migrationBatchCredentialsV1"], ["mcpCredentials", "migrationBatchMcpCredentialsV1"]] as const)
        if (Array.isArray(p[field]) && p[field].length && !this.supportsCapability(cap)) throw new MobileMigrationError("migration_credentials_update_required");
      if (p.reuseExisting === true && !this.supportsCapability("migrationReuseV1")) throw new MobileMigrationError("migration_update_required");
    }
    if ((name === "items" || name === "itemPlan") && (p.includeTemplates === true || p.includeTemplate === true) && !this.supportsCapability("migrationTemplatesV1")) throw new MobileMigrationError("migration_update_required");
    const reservedIntent = name === "continuationCreate" && options?.familyDigest ? (await this.intents()).find(row => row.method === rule.method && row.familyDigest === options.familyDigest && row.requestId === p.requestId && row.sourceJobId === p.sourceJobId && row.viewId === p.viewId) : undefined;
    const reservedMemory = name === 'memoryControl' ? (await this.intents()).find(row => row.id === p.requestId) : undefined;
    if (reservedMemory && (reservedMemory.method !== rule.method || ['requestId', 'id', 'ownerOperationId', 'expectedRevision', 'enabled', 'confirmUnverifiedNotes'].some(key => (reservedMemory.memoryControl as unknown as Record<string, unknown> | undefined)?.[key] !== p[key]))) throw new MobileMigrationError('migration_recovery_identity_changed');
    this.assert();
    const lane = rule.method + ":" + String(p.jobId ?? p.operationId ?? p.requestId ?? "new");
    if (!rule.read && this.mutations.has(lane)) throw new MobileMigrationError("migration_operation_pending");
    let intent: MigrationIntent | undefined;
    if (!rule.read) this.mutations.add(lane);
    // Connection holds and domains with their own durable selector stores do not
    // duplicate control records in the generic migration locator journal.
    if (!rule.read && !rule.transient) {
      intent = { id: migrationRequestId(), method: rule.method, createdAt: Date.now(), phase: "intent" };
      for (const key of ["jobId", "operationId", "requestId", "planId"] as const) if (typeof p[key] === "string") intent[key] = p[key];
      if (typeof p.expectedSequence === "number") intent.sequence = p.expectedSequence;
      if (options?.familyDigest) intent.familyDigest = options.familyDigest;
      if (typeof p.viewId === "string") intent.viewId = p.viewId;
      if (typeof p.sourceJobId === "string") intent.sourceJobId = p.sourceJobId;
      if (typeof p.continuationJobId === "string") intent.continuationJobId = p.continuationJobId;
      if (p.selection) intent.selection = p.selection as MigrationIntent["selection"];
      if (["historyCreate", "reinterpretCreate", "continuationCreate"].includes(name)) intent.jobId = p.requestId as string;
      if (name === "localPrepare") intent.operationId = p.requestId as string;
      if (name === 'memoryControl') {
        intent = reservedMemory ?? { ...intent, id: String(p.requestId), memoryControl: params as MigrationCalls['memoryControl'][0] };
      }
      if (reservedIntent) intent = reservedIntent;
    }
    let sent = false;
    try {
      if (intent) await this.journal.put(intent);
      this.assert();
      sent = true;
      const result = await this.request(rule.method, params);
      if(rule.method.startsWith('migration/history/view/') && rule.result(result) && validHistoryLifecycleResult(rule.method,params,result)) {
        const lease=(result as Record<string,any>).lease;
        if(lease&&this.viewBindings.get(lease.requestId)!==JSON.stringify([lease.jobId,lease.archiveId,lease.viewId??null]))throw new MobileMigrationError('migration_invalid_response');
        if(lease&&(lease.state==='active'||lease.state==='invalidated')) {
          if(this.available()) this.viewHolds.set(lease.requestId,lease.leaseId);
          else this.releaseView(lease.requestId,lease.leaseId);
        } else if(lease) this.viewHolds.delete(lease.requestId);
      }
      this.assert();
      if (!rule.result(result)) throw new MobileMigrationError("migration_invalid_response");
      if (batchControlMethod(rule.method) && !validBatchControlCall(rule.method, params, result)) throw new MobileMigrationError("migration_invalid_response");
      if (rule.method === CREDENTIAL_SOURCES_METHOD && !validCredentialSources(params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (Object.values(PROJECTS_METHODS).some(value => value === rule.method) && !validProjectCall(rule.method, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (rule.method === PROJECT_MCP_METHOD && !validProjectMcpCatalog(params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (resourceAttachmentMethod(rule.method) && !validResourceAttachment(rule.method, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (historyResourceMethod(rule.method) && !validHistoryResourceCall(rule.method, params, result)) throw new MobileMigrationError("migration_invalid_response");
      if (!resourceAttachmentMethod(rule.method) && rule.method !== "migration/batch/resources/attach" && rule.method.startsWith("migration/batch/resources/") && !validResourceCall(rule.method, params, result)) throw new MobileMigrationError("migration_invalid_response");
      if (!validMemoryResult(name, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if ((rule.method === INSTRUCTION_METHODS.page || rule.method === INSTRUCTION_METHODS.body) && !validInstructionCall(rule.method, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (rule.method === AGENT_PREVIEW_METHOD && !validAgentPreview(params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (rule.method.startsWith('migration/definitions/') && !validDefinitionCall(rule.method, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (!validSourceUploadResult(name, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if ((rule.method.startsWith('migration/history/view/') || rule.method.startsWith('migration/history/retirement/')) &&
          !validHistoryLifecycleResult(rule.method, params, result)) throw new MobileMigrationError('migration_invalid_response');
      if (name === "configurationLayers" && !validConfigurationLayers(params as MigrationConfigurationLayersParams, result as MigrationConfigurationLayersResult)) throw new MobileMigrationError("migration_invalid_response");
      if (name === "codexLayersSelect" && !validCodexLayerSelection(params as MigrationCodexLayersSelectParams, result as MigrationCodexLayersSelectResult) || name === "codexLayersRead" && !validCodexLayerReport(params as CodexReportParams, result as MigrationCodexLayersReadResult)) throw new MobileMigrationError("migration_invalid_response");
      if (!validHistoricalResult(name, params, result)) throw new MobileMigrationError("migration_invalid_response");
      const value = result as Record<string, any>;
      const job = value.state?.job ?? value.job;
      if (p.jobId && job && job.jobId !== p.jobId || p.operationId && job && (name === "uploadCollectionAttachment" ? job.state?.operationId : job.operationId) !== p.operationId)
        throw new MobileMigrationError("migration_invalid_response");
      if (name === "pluginPlan" && job?.operationId !== p.requestId) throw new MobileMigrationError("migration_invalid_response");
      if (name === "historySources" && value.catalogId !== p.catalogId) throw new MobileMigrationError("migration_invalid_response");
      if ((name === "assetPreview" && value.itemId !== p.itemId) || (name === "itemPlan" && value.item?.itemId !== p.itemId)) throw new MobileMigrationError("migration_invalid_response");
      if (name === "assetPreview" && (typeof value.text !== "string" || value.text.length > 64 * 1024 || value.nextOffset != null && value.nextOffset <= Number(p.offset ?? 0))) throw new MobileMigrationError("migration_invalid_response");
      for (const key of rule.rows ?? []) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 10)) throw new MobileMigrationError("migration_invalid_response");
      if (p.cursor != null && value.nextCursor === p.cursor) throw new MobileMigrationError("migration_invalid_response");
      if (intent) await this.journal.put({ ...intent, phase: "acknowledged", ...(job?.jobId ? {jobId: job.jobId} : {}), ...(job?.operationId ? {operationId: job.operationId} : {}) });
      this.assert();
      return result as MigrationCalls[N][1];
    } catch (error) {
      if (intent && sent) {
        try { await this.journal.put({ ...intent, phase: "unknown" }); } catch { /* The original intent remains; no alternate operation is dispatched. */ }
      }
      throw new MobileMigrationError(migrationError(error));
    } finally { if (!rule.read) this.mutations.delete(lane); }
  }
}
