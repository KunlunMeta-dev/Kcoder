import type {
  IntegrationRequest,
  IntegrationScope,
  OfficeArtifactManifest,
} from '../../../../shared/generated/contracts'
import {
  isIntegrationReply,
  isIntegrationScope,
  isOfficeArtifactManifest,
  isOfficeExportReceipt,
  isOfficeExportAcknowledgementResult,
  isOfficeExportAcknowledgementReceipt,
} from '../../../../shared/generated/contractGuards.mjs'
import { requestLocalExecutor } from '@/host/localExecutor'
import { invokeRuntimeCommand } from '@/kcoder/gatewayServiceBridge'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { desktopHost } from '@/kcoder/desktopHost'
import { downloadLink } from '@/kcoder/downloadLink'
import { createRandomUuid } from '@/lib/random-id'
import { OfficeClientError } from '@/features/office-integration/controller'
import type { NativeOfficeDownloadResult, NativeOfficeFiles } from './nativeOfficeTransport'

const MAXIMUM = 100 * 1024 * 1024
const mediaTypes = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
}
function sameScope(left: IntegrationScope, right: IntegrationScope) {
  return (
    left.accountId === right.accountId &&
    left.targetId === right.targetId &&
    left.workspaceId === right.workspaceId &&
    (left.organizationId ?? null) === (right.organizationId ?? null) &&
    left.identityGeneration === right.identityGeneration &&
    left.targetRevision === right.targetRevision
  )
}
function sameOwner(manifest: Pick<OfficeArtifactManifest, 'owner'>, scope: IntegrationScope) {
  return (
    manifest.owner.accountId === scope.accountId &&
    manifest.owner.targetId === scope.targetId &&
    manifest.owner.workspaceId === scope.workspaceId &&
    (manifest.owner.organizationId ?? null) === (scope.organizationId ?? null)
  )
}

/** Existing attachment IPC and download bridges only. A prepared lease is never a saved file. */
export const nativeOfficeReadExport: NonNullable<NativeOfficeFiles['readExport']> = async (
  value,
  context
) => {
  const target = { ...context.target }
  const scope = structuredClone(context.scope)
  const { signal } = context
  const hasAutomationRun = context.automationRunId !== undefined
  if (
    hasAutomationRun &&
    (typeof context.automationRunId !== 'string' ||
      !context.automationRunId.trim() ||
      Array.from(context.automationRunId).length > 256)
  )
    throw new OfficeClientError('OFFICE_EXPORT_RECEIPT_INVALID', 'none')
  const currentAccount = captureAccountContextRevision()
  const check = () => {
    if (signal.aborted) throw new OfficeClientError('OFFICE_CANCELLED', 'retry_read')
    if (
      !currentAccount(target.serverId) ||
      context.isCurrent?.() === false ||
      context.target.serverId !== target.serverId ||
      context.target.workspacePath !== target.workspacePath ||
      !sameScope(context.scope, scope)
    )
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
  }
  check()
  if (
    !isOfficeExportReceipt(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAXIMUM ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= Date.now() ||
    !/^[a-f0-9]{64}$/i.test(value.sha256) ||
    !value.filename ||
    value.filename.length > 200 ||
    /[\\/:]/.test(value.filename) ||
    Array.from(value.filename).some(character => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) ||
    !/^[a-zA-Z0-9._-]{1,256}$/.test(value.exportId) ||
    !/^[a-zA-Z0-9._-]{1,256}$/.test(value.leaseRevision)
  )
    throw new OfficeClientError('OFFICE_EXPORT_RECEIPT_INVALID', 'retry_read')
  const receipt = structuredClone(value)
  const validLease = () => {
    check()
    if (receipt.expiresAtMs <= Date.now())
      throw new OfficeClientError('OFFICE_EXPORT_LEASE_EXPIRED', 'retry_read')
  }
  const currentScope = async () => {
    validLease()
    const actual = await requestLocalExecutor<unknown>(
      'runtime.integrations.request',
      { ...target, method: 'integrations/scope/read', params: {} },
      { signal }
    )
    validLease()
    if (!isIntegrationScope(actual) || !sameScope(actual, scope))
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
  }
  await currentScope()
  const request: IntegrationRequest = {
    contractVersion: 'parallel-v1',
    requestId: `office-reader-${createRandomUuid()}`,
    scope: structuredClone(scope),
    timeoutMs: 30_000,
    payload: { reference: receipt.reference },
  }
  const reply = await requestLocalExecutor<unknown>(
    'runtime.integrations.request',
    { ...target, method: 'integrations/artifact/read', params: request },
    { signal }
  )
  validLease()
  if (
    !isIntegrationReply(reply) ||
    reply.requestId !== request.requestId ||
    reply.operationId !== null ||
    reply.status !== 'completed' ||
    !reply.result ||
    !isOfficeArtifactManifest(reply.result.manifest)
  )
    throw new OfficeClientError('OFFICE_EXPORT_MANIFEST_UNAVAILABLE', 'retry_read')
  const manifest = reply.result.manifest
  if (
    !sameOwner(manifest, scope) ||
    manifest.id !== receipt.reference.id ||
    manifest.revision !== receipt.reference.revision ||
    manifest.bytes !== receipt.bytes ||
    manifest.sha256.toLowerCase() !== receipt.sha256.toLowerCase() ||
    mediaTypes[manifest.format] !== receipt.mediaType ||
    !manifest.task.threadId
  )
    throw new OfficeClientError('OFFICE_EXPORT_RECEIPT_INVALID', 'retry_read')
  const locator = `office-export:${receipt.exportId}:${receipt.leaseRevision}`
  const transfer = await invokeRuntimeCommand<{ contentBase64?: unknown; size?: unknown }>(
    'read_local_attachment_file',
    {
      deviceId: target.serverId,
      workspacePath: target.workspacePath,
      threadId: manifest.task.threadId,
      path: locator,
      mimeType: receipt.mediaType,
    },
    { signal }
  )
  validLease()
  if (typeof transfer.contentBase64 !== 'string' || transfer.size !== receipt.bytes)
    throw new OfficeClientError('OFFICE_CONTENT_IDENTITY_MISMATCH', 'retry_read')
  let binary: string
  try {
    binary = atob(transfer.contentBase64)
  } catch {
    throw new OfficeClientError('OFFICE_CONTENT_IDENTITY_MISMATCH', 'retry_read')
  }
  if (binary.length !== receipt.bytes)
    throw new OfficeClientError('OFFICE_CONTENT_IDENTITY_MISMATCH', 'retry_read')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  validLease()
  if (sha256 !== receipt.sha256.toLowerCase())
    throw new OfficeClientError('OFFICE_CONTENT_IDENTITY_MISMATCH', 'retry_read')
  await currentScope()
  let acknowledgement: NativeOfficeDownloadResult['acknowledgement']
  if (hasAutomationRun) {
    const operationId = `export-ack-${receipt.exportId}`
    const request: IntegrationRequest = {
      contractVersion: 'parallel-v1',
      requestId: createRandomUuid(),
      operationId,
      scope: structuredClone(scope),
      timeoutMs: 30_000,
      payload: {
        exportId: receipt.exportId,
        leaseRevision: receipt.leaseRevision,
        reference: receipt.reference,
        automationRunId: context.automationRunId,
        bytes: bytes.length,
        sha256,
      },
    }
    try {
      const raw = await requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        {
          ...target,
          method: 'integrations/artifact/acknowledgeExport',
          params: request,
        },
        { signal }
      )
      check()
      acknowledgement =
        isIntegrationReply(raw) &&
        raw.operationId === operationId &&
        raw.status === 'completed' &&
        isOfficeExportAcknowledgementResult(raw.result) &&
        raw.result.exportId === receipt.exportId &&
        raw.result.acknowledgement === 'client_acknowledged' &&
        raw.result.reference.id === receipt.reference.id &&
        raw.result.reference.revision === receipt.reference.revision &&
        raw.result.claim != null &&
        raw.result.receipt == null &&
        raw.result.claim.runId === context.automationRunId &&
        raw.result.claim.exportId === receipt.exportId &&
        raw.result.claim.bytes === receipt.bytes &&
        raw.result.claim.sha256 === sha256 &&
        raw.result.claim.owner.accountId === scope.accountId &&
        raw.result.claim.owner.targetId === scope.targetId &&
        raw.result.claim.owner.workspaceId === scope.workspaceId &&
        (raw.result.claim.owner.organizationId ?? null) === (scope.organizationId ?? null)
          ? 'confirmed'
          : 'unconfirmed'
    } catch {
      check()
      acknowledgement = 'unconfirmed'
    }
  }
  if (!hasAutomationRun) {
    const operationId = `export-ack-${receipt.exportId}`
    const sameReceipt = (value: unknown) =>
      isOfficeExportAcknowledgementReceipt(value) &&
      value.operationId === operationId &&
      value.exportId === receipt.exportId &&
      value.reference.id === receipt.reference.id &&
      value.reference.revision === receipt.reference.revision &&
      value.bytes === bytes.length &&
      value.sha256 === sha256 &&
      sameOwner(value, scope) &&
      value.task.threadId === manifest.task.threadId &&
      value.task.turnId === manifest.task.turnId &&
      (value.task.runId ?? null) === (manifest.task.runId ?? null) &&
      value.sourceIdentities.length === manifest.sourceRefs.length &&
      value.sourceIdentities.every((input, index) => {
        const source = manifest.sourceRefs[index]
        return (
          input.reference.kind === source.kind &&
          input.reference.id === source.id &&
          input.reference.revision === source.revision
        )
      })
    const request: IntegrationRequest = {
      contractVersion: 'parallel-v1',
      requestId: createRandomUuid(),
      operationId,
      scope: structuredClone(scope),
      timeoutMs: 30_000,
      payload: {
        exportId: receipt.exportId,
        leaseRevision: receipt.leaseRevision,
        reference: receipt.reference,
        bytes: bytes.length,
        sha256,
      },
    }
    acknowledgement = 'unconfirmed'
    try {
      const raw = await requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        {
          ...target,
          method: 'integrations/artifact/acknowledgeExport',
          params: request,
        },
        { signal }
      )
      check()
      if (
        isIntegrationReply(raw) &&
        raw.requestId === request.requestId &&
        raw.operationId === operationId &&
        raw.status === 'completed' &&
        isOfficeExportAcknowledgementResult(raw.result) &&
        raw.result.claim == null &&
        raw.result.acknowledgement === 'client_acknowledged' &&
        sameReceipt(raw.result.receipt)
      )
        acknowledgement = 'confirmed'
    } catch {
      check()
    }
    if (acknowledgement === 'unconfirmed') {
      // A lost ACK observes only the same original operation; it never repeats a save or a new ACK.
      const read: IntegrationRequest = {
        contractVersion: 'parallel-v1',
        requestId: createRandomUuid(),
        scope: structuredClone(scope),
        timeoutMs: 30_000,
        payload: { operationId },
      }
      try {
        const raw = await requestLocalExecutor<unknown>(
          'runtime.integrations.request',
          {
            ...target,
            method: 'integrations/office/readOperation',
            params: read,
          },
          { signal }
        )
        check()
        if (
          isIntegrationReply(raw) &&
          raw.requestId === read.requestId &&
          raw.operationId === null &&
          raw.status === 'completed' &&
          raw.result?.method === 'office.acknowledgeExport' &&
          raw.result.operationId === operationId &&
          raw.result.phase === 'completed' &&
          sameReceipt(raw.result.result)
        )
          acknowledgement = 'confirmed'
      } catch {
        check()
      }
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: receipt.mediaType }))
  const outcome = (status: NativeOfficeDownloadResult['status']): NativeOfficeDownloadResult => ({
    status,
    filename: receipt.filename,
    bytes: receipt.bytes,
    sha256,
    ...(acknowledgement ? { acknowledgement } : {}),
  })
  try {
    validLease()
    const host = desktopHost()
    if (host?.download) {
      try {
        const result = await host.download({ url, filename: receipt.filename })
        check()
        if (!['completed', 'cancelled', 'interrupted'].includes(result.status))
          throw new Error('invalid desktop outcome')
        window.dispatchEvent(new CustomEvent('kcoder:download-result', { detail: result }))
        return outcome(result.status)
      } catch {
        check()
        window.dispatchEvent(
          new CustomEvent('kcoder:download-result', {
            detail: { status: 'interrupted', filename: receipt.filename },
          })
        )
        return outcome('interrupted')
      }
    }
    const link = document.createElement('a')
    link.href = url
    link.download = receipt.filename
    link.rel = 'noopener'
    link.hidden = true
    document.body.appendChild(link)
    try {
      await downloadLink(link)
      check()
      return outcome('download_requested')
    } finally {
      link.remove()
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
