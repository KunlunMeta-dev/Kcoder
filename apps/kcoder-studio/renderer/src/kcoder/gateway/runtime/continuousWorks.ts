import {
  isContinuousWorkControlResult,
  isContinuousWorkControlTarget,
  isContinuousWorkListResult,
  isContinuousWorkReadResult,
} from '../../../../../shared/generated/contractGuards.mjs'
import type { ContinuousWorkView } from '../../../../../shared/generated/contracts'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { GatewayRpcError } from '../../gatewayRpc'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { text } from './contracts'
import type { GatewayRuntimeCore } from './core'

export interface ContinuousWorkBatch {
  status: 'complete' | 'more' | 'unsupported' | 'unavailable'
  items: ContinuousWorkView[]
  pageCount: number
  nextCursor?: string
  incomplete?: boolean
}

const PAGE_BUDGET = 10
const BATCH_TIMEOUT_MS = 3_000
const validId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value)
const validCursor = (value: string) =>
  value.length > 0 && new TextEncoder().encode(value).length <= 2048 && !/\p{Cc}/u.test(value)

/** A validated identity atom; the request is rejected rather than coerced. */
function requiredText(value: unknown): string {
  const parsed = text(value)
  if (!parsed || parsed !== parsed.trim()) throw new Error('CONTINUOUS_WORK_REQUEST_INVALID')
  return parsed
}

/** Read only from a known target/workspace; never activate or alter a thread. */
export async function readContinuousWorks(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<ContinuousWorkBatch> {
  const targetId = requiredText(params.deviceId)
  const workspace = requiredText(params.workspacePath)
  const initialCursor = typeof params.cursor === 'string' ? params.cursor : undefined
  if (
    !targetId ||
    !workspace ||
    (params.cursor != null && !initialCursor) ||
    (initialCursor && !validCursor(initialCursor))
  )
    throw new Error('CONTINUOUS_WORK_TARGET_INVALID')
  options?.signal?.throwIfAborted()
  const account = captureAccountContextRevision()
  const server = await runtime.serverForParams({ deviceId: targetId })
  const targetScope = hookTargetScope(server)
  if (
    runtime.disposed ||
    !account(targetId) ||
    server.id !== targetId ||
    ![...runtime.tasks.values()].some(
      task =>
        task.serverId === targetId &&
        !task.ephemeral &&
        sameWorkspacePath(task.workspacePath, workspace)
    )
  )
    throw new Error('CONTINUOUS_WORK_TARGET_UNAVAILABLE')
  const generation = runtime.workspaceScanGeneration
  return runtime.withTransientClient<ContinuousWorkBatch>(
    server,
    async client => {
      if (client.supportsExperimental?.('continuousWorkReadV1') !== true)
        return { status: 'unsupported', items: [], pageCount: 0 }
      const items: ContinuousWorkView[] = []
      const seen = new Set<string>()
      let cursor = initialCursor ?? undefined
      let pageCount = 0
      let incomplete = false
      let allowPartial = client.supportsExperimental?.('continuousWorkPartialListV1') === true
      const cancel = new AbortController()
      const abort = () => cancel.abort()
      options?.signal?.addEventListener('abort', abort, { once: true })
      if (options?.signal?.aborted) cancel.abort()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        abort()
      }, BATCH_TIMEOUT_MS)
      try {
        for (let page = 0; page < PAGE_BUDGET; page++) {
          cancel.signal.throwIfAborted()
          const listParams = () => ({
            ...(cursor ? { cursor } : {}),
            ...(allowPartial ? { allowPartial: true } : {}),
          })
          let value: unknown
          try {
            value = await client.request<unknown>('work/list', listParams(), {
              signal: cancel.signal,
            })
          } catch (error) {
            // Older Gateways can forward the capability yet reject its new
            // request field. Retry only this read in legacy all-or-error mode.
            if (!allowPartial || !(error instanceof GatewayRpcError) || error.code !== -32602)
              throw error
            allowPartial = false
            value = await client.request<unknown>('work/list', listParams(), {
              signal: cancel.signal,
            })
          }
          if (
            !isContinuousWorkListResult(value) ||
            (value.partial === true && !allowPartial) ||
            value.items.length > 10 ||
            value.items.some(
              item =>
                !validId(item.workId) ||
                !validId(item.threadId) ||
                !Number.isSafeInteger(item.revision) ||
                item.revision < 1 ||
                !Number.isSafeInteger(item.requirementsRevision) ||
                item.requirementsRevision < 1 ||
                seen.has(item.workId)
            )
          )
            throw new Error('CONTINUOUS_WORK_REPLY_INVALID')
          for (const item of value.items) seen.add(item.workId)
          items.push(...value.items)
          pageCount++
          incomplete ||= value.partial === true
          const next = value.nextCursor ?? undefined
          if (
            next &&
            (!validCursor(next) ||
              next === cursor ||
              (value.items.length === 0 && value.partial !== true))
          )
            throw new Error('CONTINUOUS_WORK_CURSOR_INVALID')
          cursor = next
          if (!cursor) break
        }
        const current = await runtime.serverForParams({ deviceId: targetId })
        if (
          runtime.disposed ||
          !account(targetId) ||
          runtime.workspaceScanGeneration !== generation ||
          hookTargetScope(current) !== targetScope
        )
          throw new Error('CONTINUOUS_WORK_TARGET_CHANGED')
        return {
          status: cursor ? 'more' : 'complete',
          items,
          pageCount,
          ...(incomplete ? { incomplete: true } : {}),
          ...(cursor ? { nextCursor: cursor } : {}),
        }
      } catch (error) {
        options?.signal?.throwIfAborted()
        const current = await runtime.serverForParams({ deviceId: targetId })
        if (
          !account(targetId) ||
          runtime.disposed ||
          runtime.workspaceScanGeneration !== generation ||
          hookTargetScope(current) !== targetScope
        )
          throw error
        return {
          status: timedOut && pageCount > 0 && cursor ? 'more' : 'unavailable',
          items,
          pageCount,
          ...(incomplete ? { incomplete: true } : {}),
          ...(cursor ? { nextCursor: cursor } : {}),
        }
      } finally {
        clearTimeout(timer)
        options?.signal?.removeEventListener('abort', abort)
      }
    },
    workspace
  )
}

export interface ContinuousWorkCapabilities {
  status: 'ready' | 'unsupported' | 'unavailable'
  read: boolean
  input: boolean
  control: boolean
}

export type ContinuousWorkControlState =
  | 'accepted'
  | 'settling'
  | 'settled'
  | 'superseded'
  | 'failed'
  | 'needs_reconciliation'
  | 'unknown'
  | 'unsupported'
  | 'invalid'

export interface ContinuousWorkControlOutcome {
  state: ContinuousWorkControlState
  workId: string
  requestId: string
  revision?: number
  controlEpoch?: number
}

export interface ContinuousWorkObservationOutcome {
  status: 'ready' | 'absent' | 'unsupported' | 'unavailable'
  work?: ContinuousWorkView
}

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'stop', 'cancel_run', 'retry', 'reconcile'])
// Observed control states are open strings; anything unrecognised stays unknown.
const CONTROL_STATES = new Set<string>([
  'accepted',
  'settling',
  'settled',
  'superseded',
  'failed',
  'needs_reconciliation',
])
const CONTROL_TARGET_KINDS: Record<string, readonly string[]> = {
  pause: ['work'],
  resume: ['work'],
  stop: ['work'],
  cancel_run: ['turn', 'agent', 'workflow'],
  retry: ['turn', 'agent', 'workflow', 'operation'],
  reconcile: ['operation'],
}

/** Resolve the caller's own target and require the named workspace to be resident. */
async function ownedTarget(
  runtime: GatewayRuntimeCore,
  deviceId: string,
  workspacePath: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const account = captureAccountContextRevision()
  const server = await runtime.serverForParams({ deviceId })
  const targetScope = hookTargetScope(server)
  if (
    runtime.disposed ||
    !account(deviceId) ||
    server.id !== deviceId ||
    ![...runtime.tasks.values()].some(
      task =>
        task.serverId === deviceId &&
        !task.ephemeral &&
        sameWorkspacePath(task.workspacePath, workspacePath)
    )
  )
    throw new Error('CONTINUOUS_WORK_TARGET_UNAVAILABLE')
  const verify = async () => {
    const current = await runtime.serverForParams({ deviceId })
    if (runtime.disposed || !account(deviceId) || hookTargetScope(current) !== targetScope)
      throw new Error('CONTINUOUS_WORK_TARGET_CHANGED')
  }
  return { server, account, verify, workspace: workspacePath }
}

/** Ask the negotiated client which draft mutation names the host actually offers. */
export async function readContinuousWorkCapabilities(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<ContinuousWorkCapabilities> {
  const targetId = requiredText(params.deviceId)
  if (!targetId) throw new Error('CONTINUOUS_WORK_TARGET_INVALID')
  const account = captureAccountContextRevision()
  options?.signal?.throwIfAborted()
  const server = await runtime.serverForParams({ deviceId: targetId })
  if (runtime.disposed || !account(targetId) || server.id !== targetId)
    throw new Error('CONTINUOUS_WORK_TARGET_UNAVAILABLE')
  return runtime.withTransientClient<ContinuousWorkCapabilities>(server, async client => {
    options?.signal?.throwIfAborted()
    const read = client.supportsExperimental?.('continuousWorkReadV1') === true
    const input = read && client.supportsExperimental?.('continuousWorkInputV1') === true
    const control = read && client.supportsExperimental?.('continuousWorkControlV1') === true
    const current = await runtime.serverForParams({ deviceId: targetId })
    if (runtime.disposed || !account(targetId) || hookTargetScope(current) !== hookTargetScope(server))
      throw new Error('CONTINUOUS_WORK_TARGET_CHANGED')
    return { status: read ? 'ready' : 'unsupported', read, input, control }
  })
}

/**
 * Submit one control request. A transport failure or an unverifiable reply is
 * reported as `unknown`; the caller must re-read before deciding to resend.
 */
export async function submitContinuousWorkControl(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<ContinuousWorkControlOutcome> {
  const targetId = requiredText(params.deviceId)
  const workspace = requiredText(params.workspacePath)
  const threadId = requiredText(params.threadId)
  const workId = requiredText(params.workId)
  const requestId = requiredText(params.requestId)
  const action = requiredText(params.action)
  const target = params.target
  const expectedRevision = params.expectedRevision
  const kinds = action ? CONTROL_TARGET_KINDS[action] : undefined
  if (
    !targetId ||
    !workspace ||
    !validId(threadId) ||
    !validId(workId) ||
    !validId(requestId) ||
    !action ||
    !CONTROL_ACTIONS.has(action) ||
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 1 ||
    !isContinuousWorkControlTarget(target) ||
    !kinds ||
    !kinds.includes(target.kind)
  )
    throw new Error('CONTINUOUS_WORK_REQUEST_INVALID')
  const identity = { workId, requestId, state: 'unknown' as ContinuousWorkControlState }
  const { server, verify, workspace: ownedWorkspace } = await ownedTarget(
    runtime,
    targetId,
    workspace,
    options?.signal
  )
  const outcome = await runtime.withTransientClient<ContinuousWorkControlOutcome>(
    server,
    async client => {
      if (client.supportsExperimental?.('continuousWorkControlV1') !== true)
        return { ...identity, state: 'unsupported' }
      let value: unknown
      try {
        value = await client.request<unknown>(
          'work/control',
          { threadId, workId, requestId, expectedRevision, action, target },
          { signal: options?.signal }
        )
      } catch (error) {
        options?.signal?.throwIfAborted()
        if (error instanceof GatewayRpcError && error.code === -32601)
          return { ...identity, state: 'unsupported' }
        if (error instanceof GatewayRpcError && error.code === -32602)
          return { ...identity, state: 'invalid' }
        // The target may have committed the control before the reply was lost.
        return { ...identity, state: 'unknown' }
      }
      if (
        !isContinuousWorkControlResult(value) ||
        value.workId !== workId ||
        value.requestId !== requestId ||
        value.action !== action ||
        JSON.stringify(value.target) !== JSON.stringify(target) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        !Number.isSafeInteger(value.controlEpoch)
      )
        return { ...identity, state: 'unknown' }
      return {
        state: CONTROL_STATES.has(value.state)
          ? (value.state as ContinuousWorkControlState)
          : 'unknown',
        workId,
        requestId,
        revision: value.revision,
        controlEpoch: value.controlEpoch,
      }
    },
    ownedWorkspace
  )
  options?.signal?.throwIfAborted()
  await verify()
  return outcome
}

/** Re-read one work record; this is the only recovery path after `unknown`. */
export async function readContinuousWork(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<ContinuousWorkObservationOutcome> {
  const targetId = requiredText(params.deviceId)
  const workspace = requiredText(params.workspacePath)
  const workId = requiredText(params.workId)
  if (!targetId || !workspace || !validId(workId)) throw new Error('CONTINUOUS_WORK_REQUEST_INVALID')
  const { server, verify, workspace: ownedWorkspace } = await ownedTarget(
    runtime,
    targetId,
    workspace,
    options?.signal
  )
  const outcome = await runtime.withTransientClient<ContinuousWorkObservationOutcome>(
    server,
    async client => {
      if (client.supportsExperimental?.('continuousWorkReadV1') !== true)
        return { status: 'unsupported' }
      let value: unknown
      try {
        value = await client.request<unknown>('work/read', { workId }, { signal: options?.signal })
      } catch {
        options?.signal?.throwIfAborted()
        return { status: 'unavailable' }
      }
      if (!isContinuousWorkReadResult(value)) return { status: 'unavailable' }
      if (value.work == null) return { status: 'absent' }
      if (value.work.workId !== workId) return { status: 'unavailable' }
      return { status: 'ready', work: value.work }
    },
    ownedWorkspace
  )
  options?.signal?.throwIfAborted()
  await verify()
  return outcome
}
