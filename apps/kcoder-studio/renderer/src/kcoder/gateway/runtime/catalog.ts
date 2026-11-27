import { requestPlugins } from './pluginRequests'
import { requestRuntimeContextSettings } from './runtimeContextSettings'
import { requestTargetSettings } from './targetSettings'
import { requestAgentMessages } from './agentMessages'
import { readRuntimeClock } from '../../gatewayRuntimeClock'
import { inputDelivery } from './inputDelivery'
import { readTaskCreation } from './taskCreationRecovery'
import { sessionLifetime, taskView } from './sessionLifetime'
import { webSearchCapability, validWebSearchParams, validWebSearchResult } from '../../../../../shared/webSearchMethods.mjs'
import { requestToolsCatalog } from '../../gatewayToolsCatalog'
import { isTaskComparisonRequest, requestTaskComparison } from '../../gatewayTaskComparison'
import { requestTaskDelivery } from '../../gatewayTaskDelivery'
import { requestTaskExpert } from '../../gatewayTaskExpert'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'
import { readTaskInteractions, respondTaskInteraction } from './taskInteractions'
import {
  readContinuousWork,
  readContinuousWorkCapabilities,
  readContinuousWorks,
  submitContinuousWorkControl,
} from './continuousWorks'
import { readRemoteCatalog } from '../../remotes/catalog'
import { readStudioWorkMode } from '@/features/workbench/studioWorkMode'
import { requestWidgets } from './widgets'
import { requestNativeMigration } from '../../gatewayMigration'
import { studioPresentationParams } from '../../studioPresentation'
import {
  agentRequest,
  listSubagents,
  subscribeAgentConversation,
  unsubscribeAgentConversation,
} from './agentRequests'
import { requestComputerUseRecovery, type ComputerUseRecoverResult } from '../../gatewayComputerUse'
import { computerUseStates } from '../../computerUseState'
import { computerUseConsent } from '../../computerUseConsent'
import { requestKnowledge } from '../../gatewayKnowledge'
import { requestEvolution, supportsEvolution } from '../../gatewayEvolution'
import { requestNativeIntegration } from '../../gatewayIntegrations'
import { requestWorkspaceFiles } from '../../gatewayWorkspaceFiles'
import i18n from '@/i18n'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { assertAutomationCapabilities } from '../../automationCapabilities'
import { createAutomationWithReceipt } from '../../gatewayAutomationReceipt'
import { historyRefreshInput, requestHistoryRefreshStep } from '../../gatewayHistoryRefresh'
import {
  HOOK_CONFIGURATION_CAPABILITY,
  HOOK_CONFIGURATION_READ,
  HOOK_CONFIGURATION_UPDATE,
  hookTargetScope,
} from '../../gatewayHookConfiguration'
import { scopedModelCatalog } from '../../gatewayModelCatalog'
import { TURN_MODEL_SWITCH_CAPABILITY } from '../../modelSelectionMode'
import { GatewayRpcError } from '../../gatewayRpc'
import {
  readKeybindings,
  writeKeybindings,
} from '../../gatewayRuntimeSettings'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { KCODER_RUNTIME_NAME } from '../../legacyRuntimeAbi'
import { WorkspaceScanCancelledError } from '../../workspaceScanError'
import {
  record,
  runtimeProjectKey,
  SELECTED_SERVER_KEY,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'
import { isThreadNotResident, requestResidentTask, requestResidentTaskRpc } from './threadResidency'
import { captureRequestSessionAddressExpectation } from './sessionAddressExpectation'

// Cancellation releases a read caller; mutations still require their actual receipt.
const cancellableWorkflowReads = new Set([
  'workflow/collaboration/catalog',
  'workflow/capabilities/read',
  'workflow/verification/read',
  'workflow/storage/read',
  'workflow/versions/references',
  'workflow/versions/history/read',
  'workflow/list',
  'workflow/read',
  'workflow/versions',
  'workflow/export',
  'workflow/runs/list',
  'workflow/runs/read',
  'workflow/runs/output',
  'workflow/runs/archive/preview',
  'workflow/runs/archive/read',
  'workflow/runs/archive/list',
  'workflow/runs/requests',
])

export async function request(
  this: GatewayRuntimeCore,
  method: string,
  rawParams: unknown,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const params = { ...record(rawParams) }
  if (Object.hasOwn(params, 'address')) params.address = { ...record(params.address) }
  const assertExpectedOwner = captureRequestSessionAddressExpectation(this, params)
  if (method === 'runtime.keybindings.get') return { keybindings: readKeybindings() }
  if (method === 'runtime.keybindings.update') {
    return { keybindings: writeKeybindings(params.keybindings) }
  }
  if (method === 'runtime.clock.read') return readRuntimeClock(this, text(params.serverId) ?? '')
  if (method === 'runtime.agentMessages.request') return requestAgentMessages(this, params)
  if (method === 'runtime.input.delivery') return inputDelivery(this, params)
  if (method === 'runtime.asyncQuestion.supports')
    return supportsAsyncQuestions.call(this, params)
  if (method === 'runtime.asyncQuestion.request')
    return requestAsyncQuestion.call(this, params)
  if (method === 'runtime.taskExpert.request') return requestTaskExpert.call(this, params, options)
  if (method === 'runtime.continuousWork.list') return readContinuousWorks(this, params, options)
  if (method === 'runtime.continuousWork.capabilities')
    return readContinuousWorkCapabilities(this, params, options)
  if (method === 'runtime.continuousWork.control')
    return submitContinuousWorkControl(this, params, options)
  if (method === 'runtime.continuousWork.read') return readContinuousWork(this, params, options)
  if (method === 'runtime.taskDelivery.request')
    return requestTaskDelivery.call(this, params, options)
  if (isTaskComparisonRequest(method, params))
    return requestTaskComparison.call(this, method, params)
  if (method === 'runtime.remotes.readCatalog') return readRemoteCatalog.call(this, params, options)
  if (method === 'runtime.integrations.request')
    return requestNativeIntegration.call(this, params, options)
  if (method === 'runtime.migration.request')
    return requestNativeMigration.call(this, params, options)
  if (method === 'runtime.widgets.request') return requestWidgets.call(this, params, options)
  if (method === 'runtime.mcpApps.request') return requestWidgets.call(this, params, options, true)
  if (method === 'runtime.settings.request') return requestTargetSettings.call(this, params, options)
  if (method === 'runtime.plugins.request') return requestPlugins(this, params, assertExpectedOwner)
  const writePersonality = this.compatibility.matchesMethod(method, 'personalityWrite')
  if (writePersonality || this.compatibility.matchesMethod(method, 'personalityRead'))
    return requestRuntimeContextSettings(this, params, 'personality', writePersonality)
  const writeInstructions = this.compatibility.matchesMethod(method, 'instructionsWrite')
  if (writeInstructions || this.compatibility.matchesMethod(method, 'instructionsRead'))
    return requestRuntimeContextSettings(this, params, 'instructions', writeInstructions)
  const uploadAccountValid =
    method === 'runtime.workspaceFiles.request' ? captureAccountContextRevision() : null
  const knowledgeAccountValid =
    method === 'runtime.knowledge.request' ? captureAccountContextRevision() : null
  const workflowAccountValid =
    method === 'runtime.workflows.request' ? captureAccountContextRevision() : null
  const createAccountValid =
    ['runtime.tasks.create', 'runtime.tasks.creation.read'].includes(method)
      ? captureAccountContextRevision() : null
  const searchAccountValid = method === 'runtime.webSearch.request' ? captureAccountContextRevision() : null
  const providerAccountValid =
    method === 'runtime.providers.request' || method === 'runtime.providers.restart'
      ? captureAccountContextRevision()
      : null
  const requestGeneration = this.workspaceScanGeneration
  if (this.restartingAppServers) await this.assertRequestTargetAvailable(params)
  assertExpectedOwner?.()
  if (method === 'runtime.workspaceFiles.request' && uploadAccountValid)
    return requestWorkspaceFiles.call(this, params, uploadAccountValid)
  if (method === 'runtime.knowledge.request' && knowledgeAccountValid)
    return requestKnowledge.call(this, params, knowledgeAccountValid, options)
  if (method === 'runtime.computerUse.recover' || method === 'runtime.computerUse.revoke') {
    const descriptor = await this.taskDescriptor({ taskId: params.taskId })
    if (!descriptor || descriptor.server.id !== text(params.serverId))
      throw new Error('Desktop target does not match its task')
    const { task } = descriptor
    const client = this.clientByTask.get(task.taskId)
    if (!client || this.disconnectRecoveryByTask.has(task.taskId))
      throw new Error('Desktop session connection is not resident')
    if (method === 'runtime.computerUse.revoke') {
      computerUseConsent.set(task.serverId, task.taskId, false)
      const result = await requestComputerUseRecovery(client, 'computerUse/revoke', task.threadId)
      computerUseStates.revoked(this, task.serverId, task.taskId)
      return result
    }
    const snapshot = computerUseStates.get(task.serverId, task.taskId)
    if (
      !snapshot ||
      snapshot.turnId !== text(params.previousTurnId) ||
      snapshot.diagnostic?.authorization !== 'valid' ||
      snapshot.recoveryAvailable !== true
    )
      throw new Error('Desktop recovery is not authorized for this control turn')
    if (this.pendingTurnStartByTask.has(task.taskId))
      throw new Error('Desktop recovery is already pending')
    this.pendingTurnStartByTask.add(task.taskId)
    try {
      // A restored runtime cannot recreate a lost desktop control grant.
      const result = (await requestResidentTask(this, task, client, current =>
        requestComputerUseRecovery(current, 'computerUse/recover', task.threadId, snapshot.turnId),
      { retry: false })) as ComputerUseRecoverResult
      if (
        result.threadId !== task.threadId ||
        result.previousTurnId !== snapshot.turnId ||
        !result.turnId ||
        !['running', 'completed'].includes(result.status)
      )
        throw new Error('Desktop recovery receipt does not match this task')
      if (
        this.clientByTask.get(task.taskId) !== client ||
        this.disconnectRecoveryByTask.has(task.taskId)
      )
        throw new Error('Desktop recovery connection changed before its receipt')
      const completed =
        this.completedTurnKeys.delete(`${task.taskId}:${result.turnId}`) ||
        result.status === 'completed'
      if (!completed) this.trackActiveTurn(task.taskId, result.turnId)
      const current = this.tasks.get(task.taskId)
      if (current)
        this.tasks.set(task.taskId, { ...current, running: !completed, updatedAt: Date.now() })
      return result
    } finally {
      this.pendingTurnStartByTask.delete(task.taskId)
    }
  }
  if (method === 'runtime.computerUse.status') {
    if (!text(params.serverId)) throw new Error('A computer use target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const client = await this.commandClient(target)
    if (client.supportsExperimental?.('computerUseStatusV1') !== true)
      return { availability: 'unsupported_protocol', canControl: false }
    return client.request('computerUse/status', {})
  }
  if (method === 'runtime.usage.stats') {
    if (!text(params.serverId)) throw new Error('A usage statistics target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const client = await this.commandClient(target)
    if (client.supportsExperimental?.('usageHistory') !== true)
      throw new Error('请升级目标 KCoder 以查看最近 30 天用量')
    return client.request('usage/stats', {})
  }
  if (method === 'runtime.tools.catalog') return requestToolsCatalog.call(this, params)
  if (method === 'runtime.diagnostics.request') {
    const operation = text(params.method)
    if (
      operation !== 'diagnostics/storage/read' &&
      operation !== 'diagnostics/storage/cancel' &&
      operation !== 'diagnostics/storage/clean' &&
      operation !== 'diagnostics/debug-log/disable'
    )
      throw new Error('Unsupported diagnostics operation')
    if (!text(params.serverId)) throw new Error('A diagnostics target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const client = await this.commandClient(target)
    if (client.supportsExperimental?.('storageDiagnosticsV1') !== true)
      throw new Error(i18n.t('common:storageSettings.upgradeRequired'))
    const fields = { ...record(params.params) }
    if (
      operation === 'diagnostics/storage/cancel' &&
      client.supportsExperimental?.('storageScanCancellationV1') !== true
    )
      throw new Error(i18n.t('common:storageSettings.cancelUnsupported'))
    if (operation === 'diagnostics/storage/clean' && !('confirm' in fields)) fields.confirm = true
    return client.request(operation, fields)
  }
  if (method === 'runtime.workflows.request') {
    const operation = text(params.method)
    const readOptions = cancellableWorkflowReads.has(operation ?? '') ? options : undefined
    readOptions?.signal?.throwIfAborted()
    if (
      ![
        'workflow/capabilities/read',
        'workflow/verification/read',
        'workflow/storage/read',
        'workflow/storage/migrate',
        'workflow/storage/rollback',
        'workflow/versions/references',
        'workflow/versions/archive',
        'workflow/versions/history/read',
        'workflow/list',
        'workflow/read',
        'workflow/create',
        'workflow/collaboration/catalog',
        'workflow/collaboration/apply',
        'workflow/upsertNode',
        'workflow/moveNode',
        'workflow/removeNode',
        'workflow/delete',
        'workflow/save',
        'workflow/update',
        'workflow/versions',
        'workflow/clone',
        'workflow/export',
        'workflow/import',
        'workflow/runs/list',
        'workflow/runs/read',
        'workflow/runs/output',
        'workflow/runs/archive/preview',
        'workflow/runs/archive',
        'workflow/runs/archive/read',
        'workflow/runs/archive/list',
        'workflow/runs/requests',
        'workflow/runs/respond',
      ].includes(operation ?? '')
    )
      throw new Error('Unsupported workflow operation')
    if (!text(params.serverId)) throw new Error('A workflow target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const targetScope = hookTargetScope(target)
    const assertScope = () => {
      if (this.disposed || !workflowAccountValid?.(target.id))
        throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
    }
    assertScope()
    const client = await this.commandClient(target, text(params.workspacePath) ?? undefined)
    assertScope()
    if (hookTargetScope(await this.serverForParams({ deviceId: params.serverId })) !== targetScope)
      throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
    assertScope()
    readOptions?.signal?.throwIfAborted()
    if (client.supportsExperimental?.('workflowCanvasV1') !== true)
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (
      operation?.startsWith('workflow/collaboration/') &&
      client.supportsExperimental?.('workflowCollaborationV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (
      operation === 'workflow/moveNode' &&
      client.supportsExperimental?.('workflowLayoutV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (operation === 'workflow/capabilities/read')
      return {
        verification: client.supportsExperimental?.('workflowVerificationV1') === true,
        storage: client.supportsExperimental?.('workflowStorageV1') === true,
        versionHistory: client.supportsExperimental?.('workflowVersionHistoryV1') === true,
        scenarios: client.supportsExperimental?.('workflowVerificationScenariosV1') === true,
        conditionalRead: client.supportsExperimental?.('workflowConditionalReadV1') === true,
        runArchive: client.supportsExperimental?.('workflowRunArchiveV1') === true,
      }
    const workflowCapability =
      operation === 'workflow/verification/read'
        ? 'workflowVerificationV1'
        : operation?.startsWith('workflow/runs/archive')
          ? 'workflowRunArchiveV1'
          : operation?.startsWith('workflow/storage/')
            ? 'workflowStorageV1'
            : [
                  'workflow/versions/references',
                  'workflow/versions/archive',
                  'workflow/versions/history/read',
                ].includes(operation ?? '')
              ? 'workflowVersionHistoryV1'
              : null
    if (workflowCapability && client.supportsExperimental?.(workflowCapability) !== true)
      throw new Error(i18n.t('common:workflowVerification.unsupported'))
    const fields = { ...record(params.params) }
    if (client.supportsExperimental?.('workflowConditionalReadV1') !== true) {
      if (operation === 'workflow/read') {
        delete fields.knownRevision
        delete fields.knownUpdatedAtMs
      }
      if (operation === 'workflow/runs/read') delete fields.knownRevision
    }
    if (
      [
        'workflow/storage/migrate',
        'workflow/storage/rollback',
        'workflow/versions/archive',
        'workflow/runs/archive',
      ].includes(operation ?? '') &&
      fields.confirm !== true
    )
      throw new Error(i18n.t('common:workflowVerification.confirmationRequired'))
    const node = record(record(params.params).node)
    const importedNodes = record(record(params.params).definition).nodes
    if (
      (node.kind === 'code' ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(value => record(value).kind === 'code'))) &&
      client.supportsExperimental?.('workflowCodeV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (
      (node.kind === 'tool' ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(value => record(value).kind === 'tool'))) &&
      client.supportsExperimental?.('workflowToolV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (
      (node.kind === 'subworkflow' ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(value => record(value).kind === 'subworkflow'))) &&
      client.supportsExperimental?.('workflowSubworkflowV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    const failurePolicy = (value: unknown) => Boolean(record(record(value).config).failurePolicy)
    if (
      (failurePolicy(node) ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(failurePolicy))) &&
      client.supportsExperimental?.('workflowFailurePolicyV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    const loopBody = (value: unknown) => Boolean(record(record(record(value).config).loop).body)
    if (
      (loopBody(node) ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(loopBody))) &&
      client.supportsExperimental?.('workflowSubgraphLoopsV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    const usesNodeContract = (value: unknown) => {
      const config = record(record(value).config)
      return config.resultCheck != null || config.inputBindings != null
    }
    if (
      (usesNodeContract(node) ||
        (Array.isArray(importedNodes) && importedNodes.some(usesNodeContract))) &&
      client.supportsExperimental?.('workflowNodeContractsV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    const interactiveKinds = ['wait', 'human', 'event']
    const needsInteractions =
      interactiveKinds.includes(String(node.kind)) ||
      (operation === 'workflow/import' &&
        Array.isArray(importedNodes) &&
        importedNodes.some(value => interactiveKinds.includes(String(record(value).kind))))
    if (client.supportsExperimental?.('workflowInteractionsV1') !== true) {
      if (operation === 'workflow/runs/requests') return { supported: false, requests: [] }
      if (needsInteractions || operation === 'workflow/runs/respond')
        throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    }
    if (
      (node.kind === 'transform' ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(value => record(value).kind === 'transform'))) &&
      client.supportsExperimental?.('workflowTransformV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    const usesNamedRoutes = (value: unknown) => {
      const candidate = record(value)
      return candidate.kind === 'switch' || typeof record(candidate.runIf).equals === 'string'
    }
    if (
      (usesNamedRoutes(node) ||
        (operation === 'workflow/import' &&
          Array.isArray(importedNodes) &&
          importedNodes.some(usesNamedRoutes))) &&
      client.supportsExperimental?.('workflowSwitchV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.switchUnsupported'))
    const richOperation =
      [
        'workflow/update',
        'workflow/versions',
        'workflow/clone',
        'workflow/export',
        'workflow/import',
      ].includes(operation ?? '') ||
      (operation === 'workflow/upsertNode' &&
        ((node.kind != null && node.kind !== 'agent') ||
          node.runIf != null ||
          Object.keys(record(node.config)).length > 0))
    if (richOperation && client.supportsExperimental?.('workflowGraphV2') !== true)
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (
      operation?.startsWith('workflow/runs/') &&
      client.supportsExperimental?.('workflowRunsV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    const result = await (readOptions
      ? client.request(operation!, fields, readOptions)
      : client.request(operation!, fields))
    readOptions?.signal?.throwIfAborted()
    assertScope()
    if (hookTargetScope(await this.serverForParams({ deviceId: params.serverId })) !== targetScope)
      throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
    assertScope()
    readOptions?.signal?.throwIfAborted()
    return result
  }
  if (method === 'runtime.webSearch.request') {
    const operation = text(params.method) ?? ''
    const capability = webSearchCapability(operation)
    const fields = record(params.params)
    if (!capability || !validWebSearchParams(operation, fields)) throw new Error('SEARCH_DIAGNOSTIC_INVALID_REQUEST')
    if (!text(params.serverId)) throw new Error('SEARCH_TARGET_REQUIRED')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const scope = hookTargetScope(target)
    const current = async () => {
      if (this.disposed || !searchAccountValid?.(target.id)) throw new Error('SEARCH_TARGET_CHANGED')
      if (hookTargetScope(await this.serverForParams({ deviceId: target.id })) !== scope || !searchAccountValid(target.id))
        throw new Error('SEARCH_TARGET_CHANGED')
    }
    const taskId = text(params.taskId)
    const taskScope = taskId ? await this.taskConnection({ taskId, deviceId: target.id }) : null
    if (taskScope && (hookTargetScope(taskScope.server) !== scope || (fields.threadId && fields.threadId !== taskScope.task.threadId)))
      throw new Error('SEARCH_THREAD_TARGET_CHANGED')
    if (fields.threadId && !taskScope) throw new Error('SEARCH_THREAD_OWNER_REQUIRED')
    const client = taskScope?.client ?? await this.commandClient(target)
    await current()
    if (client.supportsExperimental?.(capability) !== true) throw new Error('SEARCH_DIAGNOSTIC_UNSUPPORTED')
    const result = await client.request(operation, fields)
    await current()
    if (!validWebSearchResult(operation, result)) throw new Error('SEARCH_DIAGNOSTIC_INVALID_RESULT')
    return result
  }
  if (method === 'runtime.evolution.supports') return supportsEvolution.call(this, params, options)
  if (method === 'runtime.evolution.request')
    return requestEvolution.call(this, params, options)
  if (method === 'runtime.providers.request') {
    const operation = text(params.method)
    if (
      operation !== 'runtime.providers.list' &&
      operation !== 'runtime.providers.templates' &&
      operation !== 'runtime.providers.upsert' &&
      operation !== 'runtime.providers.probe' &&
      operation !== 'runtime.providers.discoverModels' &&
      operation !== 'runtime.providers.clearUserOverride' &&
      operation !== 'runtime.providers.delete'
    )
      throw new Error('Unsupported provider configuration operation')
    if (!text(params.serverId)) throw new Error('A provider configuration target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const targetScope = hookTargetScope(target)
    const assertProviderScope = () => {
      if (this.disposed || !providerAccountValid?.(target.id))
        throw new Error('Provider configuration target changed')
    }
    const assertProviderTarget = async () => {
      assertProviderScope()
      if (hookTargetScope(await this.serverForParams({ deviceId: target.id })) !== targetScope)
        throw new Error('Provider configuration target changed')
      assertProviderScope()
    }
    await assertProviderTarget()
    let taskId = text(params.taskId)
    const preferredTaskId = operation === 'runtime.providers.list' ? text(params.preferredTaskId) : null
    let readClient: GatewayClient | null = null
    // Optional read context is negotiated before restoring a task on older targets.
    if (!taskId && preferredTaskId) {
      readClient = await this.commandClient(target)
      await assertProviderTarget()
      if (readClient.supportsExperimental?.('providerRuntimeScopeV1') === true)
        taskId = preferredTaskId
    }
    const taskScope = taskId
      ? await this.taskConnection({ taskId, deviceId: params.serverId })
      : null
    if (taskId && !taskScope) throw new Error('Provider configuration task is unavailable')
    if (taskScope && hookTargetScope(taskScope.server) !== targetScope)
      throw new Error('Provider configuration task belongs to another target')
    await assertProviderTarget()
    const client = taskScope?.client ?? readClient ?? (await this.commandClient(target))
    await assertProviderTarget()
    if (client.supportsExperimental?.('providerConfiguration') !== true)
      throw new Error('请升级目标 KCoder 以使用 API 配置')
    const supportsAuthenticationPolicy =
      client.supportsExperimental?.('providerAuthenticationPolicy') === true
    if (
      operation === 'runtime.providers.upsert' &&
      record(params.params).capabilities !== undefined &&
      client.supportsExperimental?.('providerModelCapabilities') !== true
    ) {
      throw new Error('[provider_probe_unsupported] 请升级目标 KCoder 以编辑模型能力')
    }
    if (operation === 'runtime.providers.templates') {
      const result =
        client.supportsExperimental?.('providerTemplates') === true
          ? record(await client.request(operation, record(params.params)))
          : { templates: [] }
      await assertProviderTarget()
      return { ...result, supportsAuthenticationPolicy }
    }
    if (
      operation === 'runtime.providers.upsert' &&
      client.supportsExperimental?.('providerConnectionValidation') !== true
    )
      throw new Error(
        '[provider_probe_unsupported] 请升级目标 KCoder；当前版本不支持保存前的 API 连通性验证'
      )
    if (
      operation === 'runtime.providers.delete' &&
      client.supportsExperimental?.('providerDeletion') !== true
    )
      throw new Error('请升级目标 KCoder 以删除 API 配置')
    const fields = { ...record(params.params) }
    if (
      operation === 'runtime.providers.discoverModels' &&
      client.supportsExperimental?.('providerModelDiscoveryV1') !== true
    )
      throw new Error('[provider_discovery_unsupported] Upgrade the target to list models')
    if (
      operation === 'runtime.providers.probe' &&
      client.supportsExperimental?.('providerIndependentProbeV1') !== true
    )
      throw new Error('The target does not support independent connection tests')
    if (
      operation === 'runtime.providers.clearUserOverride' &&
      client.supportsExperimental?.('providerClearUserOverridesV1') !== true
    )
      throw new Error('The target does not support clearing user overrides')
    if (client.supportsExperimental?.('providerIndependentProbeV1') !== true)
      delete fields.validateConnection
    if (
      operation !== 'runtime.providers.discoverModels' &&
      taskScope &&
      client.supportsExperimental?.('providerRuntimeScopeV1') === true
    )
      fields.threadId = taskScope.task.threadId
    else delete fields.threadId
    if (operation === 'runtime.providers.upsert' && !supportsAuthenticationPolicy) {
      if (fields.authentication !== undefined && record(fields.authentication).mode !== 'api_key')
        throw new Error('[provider_probe_unsupported] 请升级目标 KCoder 以使用此认证策略')
      delete fields.authentication
    }
    await assertProviderTarget()
    const result = await client.request(
      operation,
      fields,
      operation === 'runtime.providers.discoverModels' ? options : undefined
    )
    await assertProviderTarget()
    return result
  }
  if (method === 'runtime.providers.restart') {
    if (!text(params.serverId)) throw new Error('A provider configuration target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const targetScope = hookTargetScope(target)
    const assertProviderScope = () => {
      if (this.disposed || !providerAccountValid?.(target.id))
        throw new Error('Provider configuration target changed')
    }
    const assertProviderTarget = async () => {
      assertProviderScope()
      if (hookTargetScope(await this.serverForParams({ deviceId: target.id })) !== targetScope)
        throw new Error('Provider configuration target changed')
      assertProviderScope()
    }
    await assertProviderTarget()
    const client = await this.commandClient(target)
    await assertProviderTarget()
    const validation = await client.request<{ valid?: boolean }>('runtime.providers.validate', {})
    await assertProviderTarget()
    if (validation.valid !== true) throw new Error('Provider configuration validation failed')
    const result = await this.restartAppServers({ serverId: target.id, ifIdle: true })
    await assertProviderTarget()
    return result
  }
  if (method === 'runtime.automations.request') {
    const accountCurrent = captureAccountContextRevision()
    const operation = text(params.method)
    if (
      !operation ||
      !['cron/list', 'cron/create', 'cron/delete', 'cron/preview'].includes(operation)
    )
      throw new Error('Unsupported scheduled task operation')
    const address = record(params.address)
    const target = await this.serverForParams(params)
    const workspacePath = text(address.workspacePath) ?? text(params.workspacePath)
    if (!workspacePath) throw new Error('Scheduled tasks require a project workspace')
    const client = await this.commandClient(target, workspacePath)
    const fields = record(params.params)
    assertAutomationCapabilities(client, operation, fields)
    if (operation === 'cron/list' && fields.creationContext === true
      && !client.supportsExperimental?.('cronCreationReceiptsV1')) return { epoch: null }
    if (operation === 'cron/create') {
      const fingerprint = hookTargetScope(target)
      return createAutomationWithReceipt(client, fields, {
        isCurrent: () => accountCurrent(target.id) && !this.disposed,
        recoverClient: async () => {
          if (!accountCurrent(target.id) || this.disposed
            || hookTargetScope(await this.serverForParams(params)) !== fingerprint)
            throw new Error('Scheduled task target changed')
          const recovered = await this.commandClient(target, workspacePath)
          if (!accountCurrent(target.id) || this.disposed) throw new Error('Scheduled task account changed')
          return recovered
        },
      })
    }
    return client.request(operation, fields)
  }
  if (method === 'runtime.history.refresh') {
    const workspacePath = text(params.workspacePath)
    if (!text(params.deviceId) || !workspacePath)
      throw new Error('History refresh requires an explicit server and workspace')
    const input = historyRefreshInput(params)
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target, workspacePath)
    if (client.supportsExperimental?.('threadHistoryIndexRefresh') !== true)
      throw new Error(
        'The target KCoder server does not support threadHistoryIndexRefresh; upgrade it first'
      )
    if ('acknowledgeExternalWriters' in input) this.invalidateWorkspaceScans()
    const result = await this.withWorkspaceOperation(target.id, workspacePath, () =>
      requestHistoryRefreshStep(client, input)
    )
    if (result.status === 'ready') {
      // Retire snapshots taken before publication before reloading only this workspace.
      this.invalidateWorkspaceScans()
      const generation = this.workspaceScanGeneration
      const cancelled = () => this.disposed || generation !== this.workspaceScanGeneration
      const workspaces = await this.workspaceDescriptors([target], target, cancelled)
      const workspace = workspaces.find(
        value => sameWorkspacePath(value.workspacePath, workspacePath) && value.available
      )
      if (cancelled()) throw new WorkspaceScanCancelledError()
      if (!workspace) throw new Error('The refreshed workspace is no longer available')
      await this.hydratePersistedTasks([workspace], cancelled)
    }
    return result
  }
  if (method === 'runtime.tasks.list') {
    const server = await this.server().finally(assertExpectedOwner)
    return this.taskListScans.read(server, params, {
      servers: await this.servers(),
      discover: (target, cancelled) => this.workspaceDescriptors([target], server, cancelled),
      hydrate: (workspace, cancelled) => this.hydratePersistedTasks([workspace], cancelled),
      disposed: () => this.disposed,
      project: workspaces => ({
        workspaces: workspaces.map(workspace => ({
          workspacePath: workspace.workspacePath,
          workspaceKind: workspace.workspaceKind,
          ...(workspace.worktreeId ? { worktreeId: workspace.worktreeId } : {}),
          label: workspace.label,
          labelKey: workspace.labelKey,
          deviceNameKey: workspace.server.labelKey,
          projectName: workspace.projectName,
          projectKey: workspace.projectKey,
          ...(workspace.projectSource ? { projectSource: workspace.projectSource } : {}),
          ...(workspace.projectRoots ? { projectRoots: workspace.projectRoots } : {}),
          projectActive: workspace.projectActive,
          projectPinned: workspace.projectPinned,
          ...(workspace.projectPinnedOrder !== undefined
            ? { projectPinnedOrder: workspace.projectPinnedOrder }
            : {}),
          ...(workspace.projectAppearance !== undefined
            ? { projectAppearance: workspace.projectAppearance }
            : {}),
          // Gateway targets belong to the local service surface even when their transport is
          // SSH. Marking them as cloud-style remote work would make upstream disconnected-cloud
          // filtering hide them; the KCoder service adapter preserves the explicit deviceId.
          workspaceSource: 'local',
          deviceId: workspace.server.id,
          deviceName: workspace.server.label,
          deviceStatus:
            workspace.server.status ??
            (workspace.server.transport === 'local' ? 'online' : 'offline'),
          available: workspace.available,
          threadsComplete: workspace.threadsComplete === true,
          threadListIssueCount: workspace.threadListIssueCount ?? 1,
          ...(workspace.threadListSyncFailed ? { threadListSyncFailed: true } : {}),
          ...(workspace.error ? { error: workspace.error } : {}),
          tasks: Array.from(this.tasks.values())
            .filter(task => !task.ephemeral)
            .filter(
              task =>
                task.serverId === workspace.server.id &&
                sameWorkspacePath(task.workspacePath, workspace.workspacePath)
            )
            .map(task => {
              const pinnedOrder = workspace.pinnedTaskIds.indexOf(task.threadId)
              return {
                ...task,
                ...(task.model || task.modelSelectionMode === 'follow_target_default'
                  ? {
                      modelSelection: {
                        modelName:
                          task.modelSelectionMode === 'follow_target_default' ? '' : task.model!,
                        modelType: null,
                        options: {},
                      },
                    }
                  : {}),
                pinned: pinnedOrder >= 0,
                pinnedOrder: pinnedOrder >= 0 ? pinnedOrder : null,
              }
            }),
        })),
      }),
    })
  }
  if (method === HOOK_CONFIGURATION_READ || method === HOOK_CONFIGURATION_UPDATE) {
    const target = await this.serverForParams(params)
    const assertScope = () => {
      if (
        this.disposed ||
        requestGeneration !== this.workspaceScanGeneration ||
        params.targetScope !== hookTargetScope(target)
      )
        throw new GatewayRpcError('Hook configuration target or account changed', -32049, {
          kind: 'hook_config_scope_changed',
        })
    }
    assertScope()
    const client = await this.commandClient(target)
    assertScope()
    if (client.supportsExperimental?.(HOOK_CONFIGURATION_CAPABILITY) !== true)
      throw new GatewayRpcError('Target requires Hook configuration support', -32000, {
        kind: 'hook_config_unsupported',
      })
    return client.request(
      method === HOOK_CONFIGURATION_READ ? 'hooks/config/read' : 'hooks/config/update',
      method === HOOK_CONFIGURATION_READ
        ? {}
        : { hooks: params.hooks, expectedRevision: params.expectedRevision }
    )
  }
  if (method === 'runtime.hooks.list' || method === 'runtime.hooks.reload') {
    throw new GatewayRpcError('Use target-scoped Hook configuration management', -32000, {
      kind: 'hook_config_unsupported',
    })
  }
  if (this.compatibility.matchesMethod(method, 'modelsList')) {
    const target = await this.serverForParams(params)
    const taskId = text(params.taskId)
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (task && task.serverId !== target.id)
      throw new Error('Model catalog target does not match the conversation')
    const resident = taskId ? this.clientByTask.get(taskId) : undefined
    const client =
      resident ?? (await this.commandClient(target, text(params.workspacePath) ?? undefined))
    const catalog = await client.request<Record<string, unknown>>(
      'runtime.models.list',
      {
        ...params,
        ...(resident && task ? { threadId: task.threadId } : {}),
      },
      options
    )
    return scopedModelCatalog(
      catalog,
      target,
      client.supportsExperimental?.('modelSelectionModeV1') === true,
      client.supportsExperimental?.(TURN_MODEL_SWITCH_CAPABILITY) === true
    )
  }
  if (this.compatibility.matchesMethod(method, 'homeMigrationStatus')) {
    return {
      weworkCodexHome: '',
      nativeCodexHome: '',
      weworkCodexHomeExists: true,
      nativeCodexHomeExists: false,
      shouldPromptMigration: false,
    }
  }
  if (this.compatibility.matchesMethod(method, 'catalogCustomWrite')) {
    throw new Error('请通过 KCoder 运行目标设置管理模型目录，不支持旧版自定义模型目录写入')
  }
  if (this.compatibility.matchesMethod(method, 'appServerRestart'))
    return this.restartAppServers(params)
  if (method === 'device.execute_command') {
    return this.executeDeviceCommand(params, await this.serverForParams(params))
  }
  if (method === 'runtime.tasks.dispose') return this.disposeTemporaryTask(params)
  if (method === 'runtime.tasks.create' || method === 'runtime.tasks.creation.read') {
    const target = await this.serverForParams(params)
    const targetScope = hookTargetScope(target)
    const assertScope = async () => {
      if (this.disposed || !createAccountValid?.(target.id))
        throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
      const latest = await this.serverForParams(params)
      if (!createAccountValid?.(target.id) || hookTargetScope(latest) !== targetScope)
        throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
    }
    await assertScope()
    if (method === 'runtime.tasks.creation.read')
      return readTaskCreation(this, params, target, assertScope)
    return this.createTask(params, target, assertScope)
  }
  if (method === 'runtime.tasks.fork_at_turn') return this.forkTaskAtTurn(params)
  if (method === 'runtime.tasks.import_fork') {
    return {
      accepted: false,
      success: false,
      runtime: KCODER_RUNTIME_NAME,
      source: record(params.source),
      target: record(params.target),
      error: 'KCoder 客户端只支持同一服务器内按回合分叉，不支持导入外部运行时分叉包',
      code: 'unsupported_runtime_import',
    }
  }
  if (method === 'runtime.tasks.send' || method === 'runtime.tasks.interrupt_and_send') {
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const task = taskId ? this.tasks.get(taskId) : undefined
    const target = (await this.servers().finally(assertExpectedOwner))
      .find(item => item.id === task?.serverId) ?? await this.server().finally(assertExpectedOwner)
    return this.sendTask(params, target, method === 'runtime.tasks.interrupt_and_send')
  }
  if (method === 'runtime.tasks.model_switch') {
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (!task || !task.threadId || task.runtime !== KCODER_RUNTIME_NAME) {
      throw new GatewayRpcError('Model selection requires an active KCoder conversation', -32000, {
        kind: 'model_switch_unsupported_runtime',
      })
    }
    const requestedDeviceId =
      text(params.deviceId) ?? text(params.device_id) ?? text(address.deviceId)
    if (requestedDeviceId && requestedDeviceId !== task.serverId) {
      throw new GatewayRpcError('Model selection target does not match the conversation', -32049, {
        kind: 'model_switch_scope_changed',
      })
    }
    const target = await this.serverForParams({ deviceId: task.serverId })
    const taskClient = this.clientByTask.get(task.taskId)
    const client = taskClient ?? (await this.commandClient(target, task.workspacePath || undefined))
    const model = text(params.model)
    if (client.supportsExperimental?.(TURN_MODEL_SWITCH_CAPABILITY) !== true)
      return { accepted: false, model: model ?? '', appliesAt: 'next_turn' }
    if (!model) throw new Error('Model selection requires a qualified model id')
    const send = (current: GatewayClient) =>
      current.request('thread/model/select', { threadId: task.threadId, model })
    try {
      return taskClient
        ? await requestResidentTask(this, task, taskClient, send, { retry: false })
        : await send(client)
    } catch (error) {
      // Eviction settles the original turn. A later turn must keep its own
      // active selection, while the workbench applies the choice on next send.
      if (client.supportsExperimental?.('threadResidencyV1') === true &&
          isThreadNotResident(error, task.threadId, task.serverId))
        return { accepted: false, model, appliesAt: 'next_turn' }
      throw error
    }
  }
  if (method === 'runtime.tasks.compact') return this.compactTask(params)
  if (method === 'runtime.tasks.rollback') return this.rollbackTask(params)
  if (method === 'runtime.tasks.revert_file_changes') return this.revertTaskFileChanges(params)
  if (method === 'runtime.tasks.guidance') return this.guideTask(params)
  if (method === 'runtime.tasks.agent_stream_subscribe')
    return subscribeAgentConversation.call(this, params)
  if (method === 'runtime.tasks.agent_stream_unsubscribe')
    return unsubscribeAgentConversation.call(this, params)
  if (method === 'runtime.tasks.agent_list') return listSubagents.call(this, params)
  const agentMethods: Record<string, [string, string]> = {
    'runtime.tasks.agent_live_read': ['agent/live/read', 'agentLiveViewV1'],
    'runtime.tasks.agent_message_read': ['agent/message/read', 'agentCommandReceiptsV1'],
    'runtime.tasks.agent_messages_list': ['agent/messages/list', 'agentCommandReceiptsV1'],
    'runtime.tasks.agent_messages_archive': ['agent/messages/archive', 'agentCommandReceiptsV1'],
    'runtime.tasks.agent_stop': ['agent/stop', 'agentStopV1'],
  }
  const agentMethod = agentMethods[method]
  if (agentMethod) return agentRequest.call(this, params, ...agentMethod)
  if (method === 'runtime.tasks.agent_steer') return this.steerSubagent(params)
  if (method === 'runtime.tasks.agent_artifact_read') return this.readSubagentArtifact(params)
  if (method === 'runtime.session.modes') {
    const address = record(params.address)
    const descriptor = address.taskId ? await this.taskDescriptor(params) : null
    const server = descriptor?.server ?? (await this.serverForParams(params))
    const workspace =
      descriptor?.task.workspacePath ?? text(params.workspacePath) ?? server.workspacePath
    const inspect = async (client: GatewayClient) => {
      if (client.supportsExperimental?.('sessionModes') !== true) {
        throw new Error('目标 KCoder 不支持执行模式查询，请升级后重试')
      }
      const wire = studioPresentationParams(descriptor?.task.studioWorkMode ?? readStudioWorkMode(), client)
      return descriptor
        ? requestResidentTaskRpc(this, descriptor.task, client, 'session/modes', wire, options)
        : client.request('session/modes', wire)
    }
    return descriptor
      ? inspect(await this.readyTaskClient(descriptor.task))
      : this.withTransientClient(server, inspect, workspace)
  }
  if (method === 'runtime.tasks.interactions.read')
    return readTaskInteractions(this, params, options)
  if (method === 'runtime.tasks.interactions.respond')
    return respondTaskInteraction(this, params, options)
  if (method === 'runtime.tasks.goal.get') return this.getTaskGoal(params, options)
  if (method === 'runtime.tasks.goal.set') return this.setTaskGoal(params)
  if (method === 'runtime.tasks.goal.clear') return this.clearTaskGoal(params)
  if (method === 'runtime.tasks.cancel') return this.cancelTask(params)
  if (method === 'runtime.tasks.shorten_wait') return this.shortenWaitTask(params)
  if (method === 'runtime.tasks.rename') return this.renameTask(params)
  if (method === 'runtime.tasks.archive') return this.archiveTask(params)
  if (['runtime.tasks.lifetime.read', 'runtime.tasks.lifetime.set'].includes(method)) return sessionLifetime(this, method, params)
  if (['runtime.tasks.view.attach', 'runtime.tasks.view.release'].includes(method)) return taskView(this, method, params)
  if (method === 'runtime.tasks.transcript') return this.loadTaskTranscript(params)
  if (method === 'runtime.tasks.search') return this.searchTasks(params)
  if (method === 'runtime.workspace.search') {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target, this.compatibility.searchWorkspace(params))
    return client.request(method, params)
  }
  if (method === 'runtime.archived_conversations.list') return this.listArchivedTasks(params)
  if (method === 'runtime.archived_conversations.unarchive') return this.unarchiveTask(params)
  if (method === 'runtime.archived_conversations.delete') return this.deleteArchivedTask(params)
  if (method === 'runtime.archived_conversations.delete_bulk') {
    return this.deleteArchivedTasksBulk(params)
  }
  if (method === 'runtime.archived_conversations.cleanup_preview') {
    return this.cleanupArchivedTasks(params, false)
  }
  if (method === 'runtime.archived_conversations.cleanup') {
    return this.cleanupArchivedTasks(params, true)
  }
  if (method === 'runtime.archived_conversations.archive_project') {
    return this.archiveProjectTasks(params)
  }
  if (method === 'runtime.archived_conversations.archive_all') {
    return this.archiveAllTasks()
  }
  if (
    method === 'runtime.worktrees.settings.get' ||
    method === 'runtime.worktrees.settings.update' ||
    method === 'runtime.worktrees.prepare' ||
    method === 'runtime.worktrees.list' ||
    method === 'runtime.worktrees.restore' ||
    method === 'runtime.worktrees.forget' ||
    method === 'runtime.worktrees.prune'
  ) {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    return client.request(method, params)
  }
  if (method === 'runtime.worktrees.archive.preview') {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const workspacePath = text(params.path) ?? text(params.workspacePath)
    if (!workspacePath) throw new Error('工作树路径不能为空')
    if (!sameWorkspacePath(workspacePath, target.workspacePath)) {
      await this.closeCachedCommandClient(target, workspacePath)
    }
    await client.request('gateway/workspace/release', { workspacePath })
    return client.request(method, params)
  }
  if (method === 'runtime.worktrees.archive') {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const workspacePath = text(params.path) ?? text(params.workspacePath)
    const archivedConversations = workspacePath
      ? this.worktreeConversationReferences(target.id, workspacePath)
      : []
    return client.request(method, {
      ...params,
      ...(archivedConversations.length > 0 ? { archivedConversations } : {}),
    })
  }
  if (method === 'runtime.worktrees.delete') {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const workspacePath = text(params.path) ?? text(params.workspacePath)
    const archivedConversations = workspacePath
      ? this.worktreeConversationReferences(target.id, workspacePath)
      : []
    return client.request(method, {
      ...params,
      ...(archivedConversations.length > 0 ? { archivedConversations } : {}),
    })
  }
  if (method === 'runtime.sidebar.tasks.pin') {
    const target = await this.serverForParams(params)
    const threadId = text(params.threadId)
    const taskId = threadId ? this.taskByThread.get(this.threadKey(target.id, threadId)) : undefined
    // A command socket must not mutate a thread owned by the task socket.
    const owner = taskId ? this.clientByTask.get(taskId) : undefined
    const client = owner ?? (await this.commandClient(target))
    return client.request(method, params)
  }
  if (
    method === 'runtime.workspaces.open' ||
    method === 'runtime.workspaces.prepare' ||
    method === 'runtime.workspaces.delete' ||
    method === 'runtime.projects.upsert_local' ||
    method === 'runtime.workspaces.rename' ||
    method === 'runtime.workspaces.remove' ||
    method === 'runtime.sidebar.projects.reorder' ||
    method === 'runtime.sidebar.projects.appearance' ||
    method === 'runtime.sidebar.projects.sync_remote' ||
    method === 'runtime.sidebar.tasks.reorder'
  ) {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    if (
      method === 'runtime.projects.upsert_local' &&
      params.preserveExisting === true &&
      !client.supportsExperimental?.('migrationProjectsV1')
    )
      throw new Error('migration_projects_update_required')
    const result = await client.request(method, params)
    const removedPath = method === 'runtime.workspaces.remove' && record(result).accepted === true
      ? text(params.workspacePath) : null
    if (removedPath) {
      this.invalidateWorkspaceScans()
      this.trackAsyncJob(this.closeCachedCommandClient(target, removedPath))
    }
    return result
  }
  if (method === 'runtime.sidebar.projects.pin') {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const synthetic = text(params.projectKey) === runtimeProjectKey(target.id)
    if (params.rootProject !== undefined)
      throw new Error('Root project routing is owned by the gateway')
    if (synthetic && client.supportsExperimental?.('sidebarRootPinning') !== true) {
      throw new Error('Upgrade the target KCoder to change root project pinning')
    }
    if (synthetic) {
      const registry = await client.request<unknown>(
        'runtime.workspaces.list',
        { deviceId: target.id }
      )
      const registryItems =
        registry &&
        typeof registry === 'object' &&
        !Array.isArray(registry) &&
        Array.isArray((registry as Record<string, unknown>).items)
          ? ((registry as { items: unknown[] }).items)
          : null
      if (
        !registryItems ||
        registryItems.some(item => !item || typeof item !== 'object' || Array.isArray(item))
      ) {
        throw new Error('Could not verify project pin target: workspace registry is invalid')
      }
      const requestedKey = text(params.projectKey)
      const hasRegisteredKeyCollision = registryItems.some(item => {
        const registeredItem = record(item)
        return (
          text(registeredItem.projectKey) === requestedKey ||
          text(registeredItem.workspacePath) === requestedKey
        )
      })
      if (hasRegisteredKeyCollision) {
        throw new Error(
          'Project pin target is ambiguous: a registered project uses the synthetic root key'
        )
      }
    }
    return client.request(
      method,
      synthetic ? { ...params, projectKey: target.workspacePath, rootProject: true } : params
    )
  }
  if (method === 'runtime_tasks.context') return {}
  if (method === 'projects.list') return []
  if (method === 'runtime.sidebar.projects.activate') {
    // Studio stores remote-project sidebar state on the local state device, so activation may
    // carry deviceId=local even when its workspace belongs to another gateway target. Resolve
    // the concrete workspace/project first and only fall back to that state-owner device id.
    const target = await this.serverForParams(
      text(params.workspacePath) || text(params.projectKey)
        ? Object.fromEntries(
            Object.entries(params).filter(([key]) => key !== 'deviceId' && key !== 'device_id')
          )
        : params
    )
    if (this.selectedServer !== target) this.invalidateWorkspaceScans()
    this.selectedServer = target
    localStorage.setItem(SELECTED_SERVER_KEY, target.id)
    const client = await this.commandClient(target)
    return client.request(method, { ...params, deviceId: target.id })
  }
  throw new Error(`KCoder 网关尚未实现运行时方法：${method}`)
}
