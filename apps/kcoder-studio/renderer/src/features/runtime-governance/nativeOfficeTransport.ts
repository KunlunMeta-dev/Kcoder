import { integrationControlCapability } from '../../../../shared/integrationControlMethods.mjs'
import type { IntegrationScope } from '../../../../shared/generated/contracts'
import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { OfficeClientError, type OfficeTransport } from '@/features/office-integration/controller'

export interface NativeOfficeTarget {
  serverId: string
  workspacePath?: string
}
type InputOptions = Parameters<NonNullable<OfficeTransport['prepareInput']>>[1]
export interface NativeOfficeFiles {
  automationRunId?: string
  prepareInput?: (target: NativeOfficeTarget, file: File, options: InputOptions) => Promise<unknown>
  readExport?: (
    receipt: unknown,
    context: {
      target: NativeOfficeTarget
      scope: IntegrationScope
      signal: AbortSignal
      automationRunId?: string
      isCurrent?: () => boolean
    }
  ) => Promise<void | NativeOfficeDownloadResult>
}
export interface NativeOfficeDownloadResult {
  status: 'download_requested' | 'completed' | 'cancelled' | 'interrupted'
  filename: string
  bytes: number
  sha256: string
  acknowledgement?: 'confirmed' | 'unconfirmed'
}

/** Connection-owned requests only; file capabilities are concrete host functions. */
export function nativeOfficeTransport(
  target: NativeOfficeTarget,
  scope: IntegrationScope,
  isCurrent: () => boolean,
  files: NativeOfficeFiles = {}
) {
  const owner = structuredClone(scope)
  const key = JSON.stringify(owner)
  const accountCurrent = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true
  const check = () => {
    if (!active || !isCurrent() || !accountCurrent(target.serverId))
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
  }
  const owned = async <T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>
  ) => {
    check()
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    if (signal?.aborted) cancel.abort()
    signal?.addEventListener('abort', abort, { once: true })
    pending.add(cancel)
    try {
      cancel.signal.throwIfAborted()
      const result = await run(cancel.signal)
      cancel.signal.throwIfAborted()
      check()
      return result
    } catch (error) {
      if (cancel.signal.aborted) throw new OfficeClientError('OFFICE_CANCELLED', 'retry_read')
      throw error
    } finally {
      pending.delete(cancel)
      signal?.removeEventListener('abort', abort)
    }
  }
  const call: OfficeTransport['call'] = async (method, request, options) => {
    check()
    if (
      !['officeWorkspaceV1', 'officeExportAcknowledgementV1'].includes(
        integrationControlCapability(method) ?? ''
      )
    )
      throw new OfficeClientError('OFFICE_METHOD_UNSUPPORTED', 'none')
    if (JSON.stringify(request.scope) !== key)
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
    if (
      ['integrations/artifact/export', 'integrations/dataset/export'].includes(method) &&
      !files.readExport
    )
      throw new OfficeClientError('OFFICE_EXPORT_PROVIDER_UNAVAILABLE', 'repair_configuration')
    const result = await owned(options.signal, signal =>
      requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        {
          ...target,
          method,
          params: request,
        },
        { signal }
      )
    )
    if (['integrations/assistant/list', 'integrations/artifact/list'].includes(method)) {
      const reply = result as {
        status?: unknown
        result?: { items?: unknown; nextCursor?: unknown }
      }
      if (
        reply.status === 'completed' &&
        (!Array.isArray(reply.result?.items) ||
          reply.result.items.length > 10 ||
          !(reply.result.nextCursor === null || typeof reply.result.nextCursor === 'string'))
      )
        throw new OfficeClientError('OFFICE_INVALID_REPLY', 'retry_read')
    }
    return result
  }
  const cancelPending = () => {
    for (const controller of pending) controller.abort()
  }
  const transport: OfficeTransport = { call }
  if (files.prepareInput)
    transport.prepareInput = (file, options) => {
      if (JSON.stringify(options.scope) !== key)
        return Promise.reject(new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read'))
      return owned(options.signal, signal =>
        files.prepareInput!(target, file, {
          ...options,
          signal,
          onProgress: bytes => {
            if (!signal.aborted && active && isCurrent()) options.onProgress(bytes)
          },
        })
      )
    }
  return {
    ...transport,
    cancelPending,
    dispose() {
      active = false
      cancelPending()
    },
    isCurrent() {
      return active && isCurrent() && accountCurrent(target.serverId)
    },
    readExport: files.readExport
      ? (receipt: unknown) =>
          owned(undefined, signal =>
            files.readExport!(receipt, {
              target,
              scope: structuredClone(owner),
              signal,
              isCurrent: () => active && isCurrent() && accountCurrent(target.serverId),
              ...(files.automationRunId !== undefined
                ? { automationRunId: files.automationRunId }
                : {}),
            })
          )
      : undefined,
  }
}
