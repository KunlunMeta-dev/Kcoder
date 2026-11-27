import { sameWorkspacePath, workspacePathKey } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import type { GatewayServer } from '../../gatewayRpc'
import { record, runtimeTaskId, text, type GatewayWorkspaceDescriptor } from './contracts'
import type { GatewayRuntimeCore } from './core'
import { persistentTaskWorkspaceHints } from './persistentTaskWorkspace'
import { readThreadInventory, type ThreadInventory } from './threadInventory'

type Discovery = { targetScope: string; generation: number }
type PendingDiscovery = {
  isCurrent: () => boolean
  promise: Promise<Discovery>
}
const pendingDiscoveries = new WeakMap<GatewayRuntimeCore, Map<string, PendingDiscovery>>()

/** Ordinary task URLs carry identity, never a filesystem path or a selected-target grant. */
export async function hydratePersistedTask(
  this: GatewayRuntimeCore,
  requestedTaskId: string,
  params: Record<string, unknown>,
): Promise<Discovery> {
  const accountCurrent = captureAccountContextRevision()
  const servers = await this.servers()
  const origins = servers.filter(server => requestedTaskId.startsWith(`${server.runtime ?? 'kcoder'}:${server.id}:`))
  if (origins.length !== 1) throw new Error('ORIGINAL_TASK_TARGET_UNAVAILABLE')
  const server = origins[0]
  const threadId = requestedTaskId.slice(`${server.runtime ?? 'kcoder'}:${server.id}:`.length)
  const address = record(params.address)
  const requestedDevices = [params.deviceId, params.device_id, address.deviceId, address.device_id].map(text).filter(Boolean)
  const requestedThreads = [params.threadId, address.threadId].map(text).filter(Boolean)
  if (!threadId || requestedDevices.some(id => id !== server.id) || requestedThreads.some(id => id !== threadId))
    throw new Error('ORIGINAL_TASK_IDENTITY_CHANGED')
  const scope = hookTargetScope(server)
  const configuration = this.configurationEpochByTarget.get(server.id)
  const current = () => !this.disposed && accountCurrent(server.id) &&
    this.configurationEpochByTarget.get(server.id) === configuration
  const assertCurrent = async () => {
    if (!current()) throw new Error('ORIGINAL_TASK_TARGET_CHANGED')
    const target = await this.serverForParams({ deviceId: server.id })
    if (!current() || hookTargetScope(target) !== scope)
      throw new Error('ORIGINAL_TASK_TARGET_CHANGED')
  }
  await assertCurrent()
  const reads = pendingDiscoveries.get(this) ?? new Map<string, PendingDiscovery>()
  pendingDiscoveries.set(this, reads)
  const key = JSON.stringify([requestedTaskId, scope])
  let pending = reads.get(key)
  if (!pending?.isCurrent()) {
    const generation = this.workspaceScanGeneration
    pending = {
      isCurrent: () => current() && this.workspaceScanGeneration === generation,
      promise: discoverOriginalTask(this, server, threadId, current, assertCurrent),
    }
    reads.set(key, pending)
    const entry = pending
    const retire = () => { if (reads.get(key) === entry) reads.delete(key) }
    void entry.promise.then(retire, retire)
  }
  const result = await pending.promise
  await assertCurrent()
  return { ...result }
}

/** Metadata discovery may be shared; attachment and each caller's identity checks are not. */
async function discoverOriginalTask(
  runtime: GatewayRuntimeCore,
  server: GatewayServer,
  threadId: string,
  isCurrent: () => boolean,
  assertCurrent: () => Promise<void>,
): Promise<Discovery> {
  const scope = hookTargetScope(server)
  const descriptors = await runtime.workspaceDescriptors([server], server, () => !isCurrent())
  await assertCurrent()
  const candidates = new Map(descriptors.map(workspace => [workspacePathKey(workspace.workspacePath), workspace]))
  const hints = server.workspaceHints
  if (hints?.truncated === true) throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
  if (hints?.version === 1 && Array.isArray(hints.paths) && hints.paths.length <= 64) {
    for (const path of hints.paths) {
      if (typeof path !== 'string' || !path || path.length > 4096 || /[\p{Cc}]/u.test(path)) continue
      const key = workspacePathKey(path)
      if (!candidates.has(key)) candidates.set(key, {
        server, workspacePath: path, workspaceKind: 'workspace', label: server.label,
        projectKey: `runtime-target:${server.id}`, projectName: server.label,
        projectActive: false, projectPinned: false, pinnedTaskIds: [], available: true,
      })
    }
  }
  const persistentHints = await persistentTaskWorkspaceHints(runtime, server, threadId, assertCurrent)
  await assertCurrent()
  for (const path of persistentHints) {
    const key = workspacePathKey(path)
    if (!candidates.has(key)) candidates.set(key, {
      server, workspacePath: path, workspaceKind: 'workspace', label: server.label,
      projectKey: `runtime-target:${server.id}`, projectName: server.label,
      projectActive: false, projectPinned: false, pinnedTaskIds: [], available: true,
    })
  }
  if (candidates.size > 256) throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
  const matches = new Map<string, { workspace: GatewayWorkspaceDescriptor; inventory: ThreadInventory }>()
  for (const workspace of candidates.values()) {
    if (!workspace.available) throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
    await assertCurrent()
    await runtime.withWorkspaceReadClient(server, async client => {
      if (client.supportsThreadResume?.() !== true) throw new Error('ORIGINAL_TASK_INDEX_UNSUPPORTED')
      const inventory = await readThreadInventory(runtime, workspace, client, async page => {
        await assertCurrent()
        if (page.completeness === 'partial') throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
        return true
      })
      if (!inventory?.complete) throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
      for (const value of inventory.threads) {
        const thread = record(value)
        if (text(thread.id) !== threadId) continue
        const cwd = text(thread.cwd)
        if (!cwd || !sameWorkspacePath(cwd, workspace.workspacePath))
          throw new Error('ORIGINAL_TASK_INDEX_BINDING_CHANGED')
        matches.set(workspacePathKey(cwd), { workspace, inventory })
      }
    }, workspace.workspacePath, false)
  }
  if (matches.size !== 1) throw new Error(matches.size > 1 ? 'ORIGINAL_TASK_INDEX_AMBIGUOUS' : 'ORIGINAL_TASK_NOT_FOUND')
  const source = matches.values().next().value!
  const { workspace } = source
  await assertCurrent()
  await runtime.hydratePersistedTasks([workspace], () => !isCurrent(), source)
  await assertCurrent()
  const taskId = runtimeTaskId(server, threadId)
  const task = runtime.tasks.get(taskId) ?? runtime.archivedTasks.get(taskId)
  if (!task || task.serverId !== server.id || task.threadId !== threadId ||
      !sameWorkspacePath(task.workspacePath, workspace.workspacePath))
    throw new Error('ORIGINAL_TASK_INDEX_BINDING_CHANGED')
  return { targetScope: scope, generation: runtime.workspaceScanGeneration }
}
