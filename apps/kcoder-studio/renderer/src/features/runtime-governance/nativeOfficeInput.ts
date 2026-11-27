import { sha256 } from '@noble/hashes/sha2.js'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { isIntegrationScope } from '../../../../shared/generated/contractGuards.mjs'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { invokeRuntimeCommand } from '@/kcoder/gatewayServiceBridge'
import {
  ATTACHMENT_CHUNK_BYTES,
  MAX_GATEWAY_ATTACHMENT_BYTES,
} from '@/kcoder/gatewayAttachmentTransfer'
import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import {
  OfficeClientError,
  type OfficeMaterialReceipt,
} from '@/features/office-integration/controller'
import type { NativeOfficeFiles } from './nativeOfficeTransport'

const FILE_READ_BYTES = 512 * 1024
const receiptKeys = new Set([
  'kind',
  'inputId',
  'revision',
  'operationId',
  'owner',
  'filename',
  'mediaType',
  'bytes',
  'sha256',
  'status',
])
const ownerKeys = new Set(['accountId', 'targetId', 'workspaceId', 'organizationId'])
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
function base64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The selected File is streamed once; only the original finish may accept its material. */
export const nativeOfficePrepareInput: NonNullable<NativeOfficeFiles['prepareInput']> = async (
  target,
  file,
  options
) => {
  const selected = { ...target }
  const owner = structuredClone(options.scope)
  const { signal, operationId } = options
  const accountCurrent = captureAccountContextRevision()
  const check = () => {
    if (signal.aborted)
      throw new OfficeClientError('OFFICE_CANCELLED', 'reconcile_original', operationId)
    if (!accountCurrent(selected.serverId))
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'reconcile_original', operationId)
  }
  const currentScope = async () => {
    check()
    const actual = await requestLocalExecutor<unknown>(
      'runtime.integrations.request',
      { ...selected, method: 'integrations/scope/read', params: {} },
      { signal }
    )
    check()
    if (!isIntegrationScope(actual) || !sameScope(actual, owner))
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'reconcile_original', operationId)
  }
  check()
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_GATEWAY_ATTACHMENT_BYTES ||
    !file.name.trim() ||
    Array.from(file.name).length > 200 ||
    /[\\/]/.test(file.name) ||
    file.name === '.' ||
    file.name === '..' ||
    Array.from(file.name).some(character => character.charCodeAt(0) < 32) ||
    !operationId ||
    operationId.length > 256
  )
    throw new OfficeClientError('OFFICE_INVALID_INPUT_METADATA', 'none', operationId)
  const mediaType = file.type || 'application/octet-stream'
  if (
    mediaType.length > 200 ||
    Array.from(mediaType).some(character => character.charCodeAt(0) < 32)
  )
    throw new OfficeClientError('OFFICE_INVALID_INPUT_METADATA', 'none', operationId)
  const digest = sha256.create()
  let uploadId: string | undefined
  let accepted = false
  let finishing = false
  try {
    await currentScope()
    const started = await invokeRuntimeCommand<unknown>(
      'start_local_attachment_upload',
      {
        deviceId: selected.serverId,
        workspacePath: selected.workspacePath,
        filename: file.name,
        mimeType: mediaType,
        fileSize: file.size,
        purpose: 'office_input',
      },
      { signal }
    )
    if (object(started) && typeof started.uploadId === 'string' && started.uploadId)
      uploadId = started.uploadId
    check()
    if (!uploadId || !object(started) || started.deviceId !== selected.serverId)
      throw new OfficeClientError('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original', operationId)
    let received = 0
    let index = 0
    options.onProgress(0)
    for (let offset = 0; offset < file.size; offset += FILE_READ_BYTES) {
      check()
      const bytes = new Uint8Array(await file.slice(offset, offset + FILE_READ_BYTES).arrayBuffer())
      check()
      if (bytes.length !== Math.min(FILE_READ_BYTES, file.size - offset))
        throw new OfficeClientError('OFFICE_INPUT_SIZE_MISMATCH', 'none', operationId)
      digest.update(bytes)
      for (let part = 0; part < bytes.length; part += ATTACHMENT_CHUNK_BYTES) {
        check()
        const chunk = bytes.subarray(part, part + ATTACHMENT_CHUNK_BYTES)
        const reply = await invokeRuntimeCommand<unknown>(
          'append_local_attachment_upload',
          {
            uploadId,
            index,
            contentBase64: base64(chunk),
          },
          { signal }
        )
        check()
        received += chunk.length
        if (!object(reply) || reply.receivedBytes !== received)
          throw new OfficeClientError(
            'OFFICE_INPUT_SIZE_MISMATCH',
            'reconcile_original',
            operationId
          )
        index += 1
        options.onProgress(received)
      }
    }
    const checksum = Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join(
      ''
    )
    await currentScope()
    const request: IntegrationRequest = {
      contractVersion: 'parallel-v1',
      requestId: `office-input-${createRandomUuid()}`,
      scope: owner,
      operationId,
      timeoutMs: 30_000,
      payload: {
        filename: file.name,
        mediaType,
        expectedBytes: file.size,
        expectedSha256: checksum,
      },
    }
    check()
    finishing = true
    const result = await invokeRuntimeCommand<unknown>(
      'finish_local_attachment_upload',
      {
        uploadId,
        office_input: request,
      },
      { signal }
    )
    check()
    if (
      !object(result) ||
      Object.keys(result).some(key => !receiptKeys.has(key)) ||
      result.kind !== 'office_input' ||
      result.status !== 'accepted' ||
      result.revision !== 1 ||
      result.operationId !== operationId ||
      typeof result.inputId !== 'string' ||
      !result.inputId ||
      result.inputId.length > 256 ||
      result.filename !== file.name ||
      result.mediaType !== mediaType ||
      result.bytes !== file.size ||
      typeof result.sha256 !== 'string' ||
      result.sha256.toLowerCase() !== checksum ||
      !object(result.owner) ||
      Object.keys(result.owner).some(key => !ownerKeys.has(key)) ||
      result.owner.accountId !== owner.accountId ||
      result.owner.targetId !== owner.targetId ||
      result.owner.workspaceId !== owner.workspaceId ||
      (result.owner.organizationId ?? null) !== (owner.organizationId ?? null)
    )
      throw new OfficeClientError('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original', operationId)
    await currentScope()
    accepted = true
    return result as unknown as OfficeMaterialReceipt
  } catch (error) {
    check()
    if (error instanceof OfficeClientError) throw error
    throw new OfficeClientError(
      finishing ? 'OFFICE_INPUT_UNCONFIRMED' : 'OFFICE_UNAVAILABLE',
      finishing ? 'reconcile_original' : 'retry_read',
      operationId
    )
  } finally {
    digest.destroy()
    if (uploadId && !accepted) {
      // A lost finish reply may have committed; cancel releases only the owned upload, never replays it.
      await invokeRuntimeCommand('cancel_local_attachment_upload', { uploadId }).catch(
        () => undefined
      )
    }
  }
}
