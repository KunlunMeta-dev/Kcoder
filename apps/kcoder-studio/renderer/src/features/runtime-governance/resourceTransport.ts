import { integrationControlCapability } from '../../../../shared/integrationControlMethods.mjs'
import type { IntegrationScope } from '../../../../shared/generated/contracts'
import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { ResourceClientError } from '@/features/integration-resources/controller'
import type {
  ResourceTransport,
  ResourceInputOptions,
} from '@/features/integration-resources/controller'

export interface ResourceTarget {
  serverId: string
  workspacePath?: string
  targetScope?: string
}
export interface ResourceFiles {
  automationRunId?: string
  prepareInput?: (
    target: ResourceTarget,
    file: File,
    options: ResourceInputOptions
  ) => Promise<unknown>
  readExport?: (
    receipt: unknown,
    context: {
      target: ResourceTarget
      scope: IntegrationScope
      signal: AbortSignal
      automationRunId?: string
      isCurrent?: () => boolean
    }
  ) => Promise<void | ResourceDownloadResult>
}
export interface ResourceDownloadResult {
  status: 'download_requested' | 'completed' | 'cancelled' | 'interrupted'
  filename: string
  bytes: number
  sha256: string
  acknowledgement?: 'confirmed' | 'unconfirmed'
}

/** Connection-owned requests only; file capabilities are concrete host functions. */
export function resourceTransport(
  target: ResourceTarget,
  scope: IntegrationScope,
  isCurrent: () => boolean,
  files: ResourceFiles = {}
) {
  const owner = structuredClone(scope)
  const key = JSON.stringify(owner)
  const accountCurrent = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true
  const check = () => {
    if (!active || !isCurrent() || !accountCurrent(target.serverId))
      throw new ResourceClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
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
      if (cancel.signal.aborted) throw new ResourceClientError('OFFICE_CANCELLED', 'retry_read')
      throw error
    } finally {
      pending.delete(cancel)
      signal?.removeEventListener('abort', abort)
    }
  }
  const call: ResourceTransport['call'] = async (method, request, options) => {
    check()
    if (
      ![
        'agentDefinitionManagementV1',
        'officeWorkspaceV1',
        'officeExportAcknowledgementV1',
      ].includes(integrationControlCapability(method) ?? '')
    )
      throw new ResourceClientError('OFFICE_METHOD_UNSUPPORTED', 'none')
    if (JSON.stringify(request.scope) !== key)
      throw new ResourceClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
    if (
      ['integrations/artifact/export', 'integrations/dataset/export'].includes(method) &&
      !files.readExport
    )
      throw new ResourceClientError('OFFICE_EXPORT_PROVIDER_UNAVAILABLE', 'repair_configuration')
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
        throw new ResourceClientError('OFFICE_INVALID_REPLY', 'retry_read')
    }
    return result
  }
  const cancelPending = () => {
    for (const controller of pending) controller.abort()
  }
  const transport: ResourceTransport = { call }
  if (files.prepareInput)
    transport.prepareInput = (file, options) => {
      if (JSON.stringify(options.scope) !== key)
        return Promise.reject(new ResourceClientError('OFFICE_SCOPE_CHANGED', 'retry_read'))
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
