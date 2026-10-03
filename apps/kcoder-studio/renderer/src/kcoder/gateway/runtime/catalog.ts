import { requestKnowledge } from '../../gatewayKnowledge'
import i18n from '@/i18n'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { assertAutomationCapabilities } from '../../automationCapabilities'
import { historyRefreshInput, requestHistoryRefreshStep } from '../../gatewayHistoryRefresh'
import {
  HOOK_CONFIGURATION_CAPABILITY,
  HOOK_CONFIGURATION_READ,
  HOOK_CONFIGURATION_UPDATE,
  hookTargetScope,
} from '../../gatewayHookConfiguration'
import { scopedModelCatalog } from '../../gatewayModelCatalog'
import { GatewayRpcError } from '../../gatewayRpc'
import {
  clearLegacyKCoderContext,
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
  type SharedRuntimeContext,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function request(
  this: GatewayRuntimeCore,
  method: string,
  rawParams: unknown,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const params = record(rawParams)
  const knowledgeAccountValid =
    method === 'runtime.knowledge.request' ? captureAccountContextRevision() : null
  const pluginAccountValid =
    method === 'runtime.plugins.request' ? captureAccountContextRevision() : null
  const workflowAccountValid =
    method === 'runtime.workflows.request' ? captureAccountContextRevision() : null
  const createAccountValid =
    method === 'runtime.tasks.create' ? captureAccountContextRevision() : null
  const requestGeneration = this.workspaceScanGeneration
  if (this.restartingAppServers) await this.assertRequestTargetAvailable(params)
  const server = await this.server()
  if (method === 'runtime.knowledge.request' && knowledgeAccountValid)
    return requestKnowledge.call(this, params, knowledgeAccountValid)
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
  if (method === 'runtime.tools.catalog') {
    const taskId = text(params.taskId)
    const descriptor = taskId ? await this.taskDescriptor({ taskId }) : null
    if (!descriptor && !text(params.serverId)) throw new Error('A tools catalog target is required')
    if (descriptor && text(params.serverId) && params.serverId !== descriptor.server.id)
      throw new Error('Tools catalog target does not match the task')
    const inspect = async (client: GatewayClient) => {
      if (client.supportsExperimental?.('toolsCatalog') !== true) return null
      return client.request(
        'tools/catalog',
        descriptor ? { threadId: descriptor.task.threadId } : {}
      )
    }
    if (descriptor) {
      const client = this.clientByTask.get(descriptor.task.taskId)
      if (!client || this.disconnectRecoveryByTask.has(descriptor.task.taskId))
        throw new Error('Tools catalog task is not resident')
      return inspect(client)
    }
    const target = await this.serverForParams({ deviceId: params.serverId })
    return this.withTransientClient(
      target,
      inspect,
      text(params.workspacePath) ?? target.workspacePath
    )
  }
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
    if (
      ![
        'workflow/list',
        'workflow/read',
        'workflow/create',
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
    const client = await this.commandClient(target)
    assertScope()
    if (hookTargetScope(await this.serverForParams({ deviceId: params.serverId })) !== targetScope)
      throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
    assertScope()
    if (client.supportsExperimental?.('workflowCanvasV1') !== true)
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
    if (
      operation === 'workflow/moveNode' &&
      client.supportsExperimental?.('workflowLayoutV1') !== true
    )
      throw new Error(i18n.t('common:workflowCanvas.unsupported'))
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
    const result = await client.request(operation!, record(params.params))
    assertScope()
    if (hookTargetScope(await this.serverForParams({ deviceId: params.serverId })) !== targetScope)
      throw new Error(i18n.t('common:workflowCanvas.scopeChanged'))
    assertScope()
    return result
  }
  if (method === 'runtime.settings.request') {
    const operation = text(params.method)
    if (
      operation !== 'settings/templates/list' &&
      operation !== 'settings/templates/read' &&
      operation !== 'settings/templates/save' &&
      operation !== 'settings/templates/delete' &&
      operation !== 'settings/templates/default' &&
      operation !== 'settings/turn-file-changes/read' &&
      operation !== 'settings/turn-file-changes/save' &&
      operation !== 'settings/tools/read' &&
      operation !== 'settings/tools/save'
    )
      throw new Error('Unsupported settings operation')
    if (!text(params.serverId)) throw new Error('A settings target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const client = await this.commandClient(target)
    if (operation === 'settings/tools/read' || operation === 'settings/tools/save') {
      if (client.supportsExperimental?.('toolProfilesV1') !== true)
        throw new Error(i18n.t('common:toolProfile.unsupported'))
    } else if (client.supportsExperimental?.('settingsTemplatesV1') !== true) {
      throw new Error('请升级目标 KCoder 以使用会话配置模板')
    }
    const fields = { ...record(params.params) }
    if (operation === 'settings/templates/default' && !('id' in fields)) fields.id = null
    return client.request(operation, fields)
  }
  if (method === 'runtime.providers.request') {
    const operation = text(params.method)
    if (
      operation !== 'runtime.providers.list' &&
      operation !== 'runtime.providers.templates' &&
      operation !== 'runtime.providers.upsert' &&
      operation !== 'runtime.providers.delete'
    )
      throw new Error('Unsupported provider configuration operation')
    if (!text(params.serverId)) throw new Error('A provider configuration target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const client = await this.commandClient(target)
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
    if (operation === 'runtime.providers.upsert' && !supportsAuthenticationPolicy) {
      if (fields.authentication !== undefined && record(fields.authentication).mode !== 'api_key')
        throw new Error('[provider_probe_unsupported] 请升级目标 KCoder 以使用此认证策略')
      delete fields.authentication
    }
    return client.request(operation, fields)
  }
  if (method === 'runtime.providers.restart') {
    if (!text(params.serverId)) throw new Error('A provider configuration target is required')
    const target = await this.serverForParams({ deviceId: params.serverId })
    const client = await this.commandClient(target)
    const validation = await client.request<{ valid?: boolean }>('runtime.providers.validate', {})
    if (validation.valid !== true) throw new Error('Provider configuration validation failed')
    return this.restartAppServers({ serverId: target.id, ifIdle: true })
  }
  if (method === 'runtime.automations.request') {
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
  if (method === 'runtime.plugins.request') {
    const { PLUGIN_RPC_METHODS, requiredPluginCapabilities } =
      await import('../../gatewayPluginApi')
    const pluginMethod = text(params.method)
    if (!pluginMethod || !PLUGIN_RPC_METHODS.has(pluginMethod)) {
      throw new Error('Unsupported KCoder plugin operation')
    }
    const pluginTarget = await this.serverForParams(params)
    const pluginTargetScope = hookTargetScope(pluginTarget)
    const assertPluginScope = () => {
      if (this.disposed || !pluginAccountValid?.(pluginTarget.id))
        throw new GatewayRpcError(
          'Plugin target or account changed',
          -32049,
          { kind: 'plugin_scope_changed' },
          'plugin-manage',
          'remote'
        )
    }
    assertPluginScope()
    const client = await this.commandClient(pluginTarget, text(params.workspacePath) ?? undefined)
    assertPluginScope()
    if (hookTargetScope(await this.serverForParams(params)) !== pluginTargetScope)
      throw new GatewayRpcError(
        'Plugin connection scope changed',
        -32049,
        { kind: 'plugin_scope_changed' },
        'plugin-manage',
        'remote'
      )
    assertPluginScope()
    const capabilities = requiredPluginCapabilities(pluginMethod, record(params.params))
    if (capabilities.some(capability => !client.supportsExperimental?.(capability))) {
      throw new GatewayRpcError(
        'Target runtime upgrade required for directory trust, plugin network settings or Git refresh',
        -32000,
        { kind: 'plugin_update_required' }
      )
    }
    return client.request(pluginMethod, record(params.params))
  }
  if (method === 'runtime.tasks.list') {
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
  if (method === 'runtime.keybindings.get') return { keybindings: readKeybindings() }
  if (method === 'runtime.keybindings.update') {
    return { keybindings: writeKeybindings(params.keybindings) }
  }
  if (this.compatibility.matchesMethod(method, 'instructionsRead')) {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const context = await this.sharedRuntimeContext(client)
    return { instructions: context.instructions, configPath: context.configPath }
  }
  if (this.compatibility.matchesMethod(method, 'instructionsWrite')) {
    const instructions = typeof params.instructions === 'string' ? params.instructions : ''
    if (instructions.length > 64 * 1024) throw new Error('自定义指令超过 64 KiB 限制')
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const context = await client.request<SharedRuntimeContext>('runtime.context.update', {
      instructions,
    })
    clearLegacyKCoderContext()
    return { instructions: context.instructions, configPath: context.configPath }
  }
  if (this.compatibility.matchesMethod(method, 'personalityRead')) {
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const context = await this.sharedRuntimeContext(client)
    return { personality: context.personality }
  }
  if (this.compatibility.matchesMethod(method, 'personalityWrite')) {
    if (params.personality !== 'friendly' && params.personality !== 'pragmatic') {
      throw new Error('不支持的 KCoder 个性')
    }
    const target = await this.serverForParams(params)
    const client = await this.commandClient(target)
    const context = await client.request<SharedRuntimeContext>('runtime.context.update', {
      personality: params.personality,
    })
    clearLegacyKCoderContext()
    return { personality: context.personality }
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
      client.supportsExperimental?.('modelSelectionModeV1') === true
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
  if (method === 'runtime.tasks.create') {
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
    const target = (await this.servers()).find(item => item.id === task?.serverId) ?? server
    return this.sendTask(params, target, method === 'runtime.tasks.interrupt_and_send')
  }
  if (method === 'runtime.tasks.compact') return this.compactTask(params)
  if (method === 'runtime.tasks.rollback') return this.rollbackTask(params)
  if (method === 'runtime.tasks.revert_file_changes') return this.revertTaskFileChanges(params)
  if (method === 'runtime.tasks.guidance') return this.guideTask(params)
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
      return client.request(
        'session/modes',
        descriptor ? { threadId: descriptor.task.threadId } : {}
      )
    }
    return descriptor
      ? inspect(await this.readyTaskClient(descriptor.task))
      : this.withTransientClient(server, inspect, workspace)
  }
  if (method === 'runtime.tasks.goal.get') return this.getTaskGoal(params)
  if (method === 'runtime.tasks.goal.set') return this.setTaskGoal(params)
  if (method === 'runtime.tasks.goal.clear') return this.clearTaskGoal(params)
  if (method === 'runtime.tasks.cancel') return this.cancelTask(params)
  if (method === 'runtime.tasks.shorten_wait') return this.shortenWaitTask(params)
  if (method === 'runtime.tasks.rename') return this.renameTask(params)
  if (method === 'runtime.tasks.archive') return this.archiveTask(params)
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
    return client.request(method, params)
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
    return client.request(
      method,
      synthetic ? { ...params, projectKey: target.workspacePath, rootProject: true } : params
    )
  }
  if (method === 'runtime_tasks.context') return {}
  if (method === 'projects.list') return []
  if (method === 'runtime.sidebar.projects.activate') {
    // Wework stores remote-project sidebar state on the local state device, so activation may
    // carry deviceId=local even when its workspace belongs to another gateway target. Resolve
    // the concrete workspace/project first and only fall back to that state-owner device id.
    const target = await this.serverForParams(
      text(params.workspacePath) || text(params.projectKey)
        ? Object.fromEntries(
            Object.entries(params).filter(([key]) => key !== 'deviceId' && key !== 'device_id')
          )
        : params
    )
    const previousControl = this.controlClientPromise
    this.controlClientPromise = null
    if (this.selectedServer !== target) this.invalidateWorkspaceScans()
    this.selectedServer = target
    localStorage.setItem(SELECTED_SERVER_KEY, target.id)
    void previousControl?.then(client => client.close())
    const client = await this.commandClient(target)
    return client.request(method, { ...params, deviceId: target.id })
  }
  throw new Error(`KCoder 网关尚未实现运行时方法：${method}`)
}
