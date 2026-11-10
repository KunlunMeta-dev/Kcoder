import { File as NodeFile } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import type { OfficeMaterialReceipt } from '@/features/office-integration/controller'
import { GatewayRemoteSessions } from '@/kcoder/gatewayRemoteSessions'
import type { GatewayClient } from '@/kcoder/gatewayRuntimeTypes'
import { nativeOfficeTransport } from './nativeOfficeTransport'
const fixture = vi.hoisted(() => ({ request: vi.fn(), invoke: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({ invokeRuntimeCommand: fixture.invoke }))
import { nativeOfficePrepareInput } from './nativeOfficeInput'

const scope: IntegrationScope = {
  accountId: 'owned-account',
  targetId: 'actual-native-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const target = { serverId: 'selected-ssh', workspacePath: '/actual-owned-workspace' }
const operationId = 'office-original-material-operation'
const live: GatewayRemoteSessions[] = []
afterEach(async () => {
  for (const sessions of live.splice(0)) await sessions.dispose()
  fixture.request.mockReset()
  fixture.invoke.mockReset()
})
function context(signal = new AbortController().signal, onProgress = vi.fn()) {
  return { scope, operationId, signal, onProgress }
}
function selectedFile(size = 32) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
  const file = new NodeFile([bytes], 'selected-material.csv', {
    type: 'text/csv',
  }) as unknown as File
  const fullRead = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('unbounded file read'))
  const slice = vi.spyOn(file, 'slice')
  return { file, bytes, fullRead, slice }
}
function receipt(request: IntegrationRequest): OfficeMaterialReceipt {
  return {
    kind: 'office_input',
    inputId: 'opaque-persisted-material',
    revision: 1,
    operationId: request.operationId!,
    owner: { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null },
    filename: request.payload.filename as string,
    mediaType: request.payload.mediaType as string,
    bytes: request.payload.expectedBytes as number,
    sha256: request.payload.expectedSha256 as string,
    status: 'accepted',
  }
}
async function uploadFixture(
  finish: (request: IntegrationRequest) => Promise<unknown> = async request => receipt(request)
) {
  const blocks: Uint8Array[] = []
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'attachment/upload/start') return { upload_id: 'actual-connection-upload' }
    if (method === 'attachment/upload/chunk') {
      const block = new Uint8Array(Buffer.from(params.content_base64 as string, 'base64'))
      blocks.push(block)
      const uploads = (
        sessions as unknown as { attachmentUploads: Map<string, { contentBase64: string }> }
      ).attachmentUploads
      expect([...uploads.values()].every(upload => upload.contentBase64 === '')).toBe(true)
      return {}
    }
    if (method === 'attachment/upload/finish')
      return finish(params.office_input as IntegrationRequest)
    return {}
  })
  const client = {
    request,
    close: vi.fn(),
    supportsExperimental: () => true,
  } as unknown as GatewayClient
  const server = {
    id: target.serverId,
    label: 'Owned fixture',
    transport: 'ssh' as const,
    workspacePath: '/different-default',
  }
  const commandClient = vi.fn(async () => client)
  const sessions = new GatewayRemoteSessions({ resolveServer: async () => server, commandClient })
  live.push(sessions)
  fixture.request.mockResolvedValue(scope)
  fixture.invoke.mockImplementation(async (command, params, options) => {
    const value = { ...params, signal: options?.signal }
    if (command === 'start_local_attachment_upload') return sessions.startAttachmentUpload(value)
    if (command === 'append_local_attachment_upload') return sessions.appendAttachmentUpload(value)
    if (command === 'finish_local_attachment_upload') return sessions.finishAttachmentUpload(value)
    if (command === 'cancel_local_attachment_upload') return sessions.cancelAttachmentUpload(value)
    throw new Error('unexpected IPC')
  })
  return { sessions, request, blocks, client, commandClient, server }
}

test('streams one File in 512KiB reads and original 192KiB chunks with incremental full SHA and an opaque receipt', async () => {
  const { file, bytes, fullRead, slice } = selectedFile(1_100_000)
  const upload = await uploadFixture()
  const options = context()
  const result = await nativeOfficePrepareInput(target, file, options)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  expect(result).toMatchObject({
    kind: 'office_input',
    operationId,
    bytes: bytes.length,
    sha256: checksum,
    status: 'accepted',
  })
  expect(result).not.toHaveProperty('path')
  expect(fullRead).not.toHaveBeenCalled()
  expect(slice.mock.calls).toEqual([
    [0, 512 * 1024],
    [512 * 1024, 1024 * 1024],
    [1024 * 1024, 1536 * 1024],
  ])
  expect(upload.blocks).toHaveLength(7)
  expect(upload.blocks.every(block => block.byteLength <= 192 * 1024)).toBe(true)
  expect(Buffer.compare(Buffer.concat(upload.blocks), Buffer.from(bytes))).toBe(0)
  expect(upload.commandClient).toHaveBeenCalledWith(upload.server, target.workspacePath)
  const finish = upload.request.mock.calls.find(
    ([method]) => method === 'attachment/upload/finish'
  )![1]
  expect(finish).toMatchObject({
    upload_id: 'actual-connection-upload',
    office_input: {
      scope,
      operationId,
      timeoutMs: 30_000,
      payload: {
        filename: file.name,
        mediaType: file.type,
        expectedBytes: file.size,
        expectedSha256: checksum,
      },
    },
  })
  expect(Object.keys((finish.office_input as IntegrationRequest).payload).sort()).toEqual([
    'expectedBytes',
    'expectedSha256',
    'filename',
    'mediaType',
  ])
  expect(options.onProgress.mock.calls.at(-1)).toEqual([file.size])
  expect(
    upload.request.mock.calls
      .map(([method]) => method)
      .every(method => method.startsWith('attachment/upload/'))
  ).toBe(true)
  const retained = upload.sessions as unknown as {
    attachmentUploads: Map<string, unknown>
    attachmentByPath: Map<string, unknown>
  }
  expect(retained.attachmentUploads.size).toBe(0)
  expect(retained.attachmentByPath.size).toBe(0)
})

test('rejects foreign, changed or path-bearing finish receipts without replaying acceptance', async () => {
  for (const mutate of [
    (value: OfficeMaterialReceipt) => ({
      ...value,
      owner: { ...value.owner, accountId: 'other-owner' },
    }),
    (value: OfficeMaterialReceipt) => ({ ...value, operationId: 'different-operation' }),
    (value: OfficeMaterialReceipt) => ({ ...value, sha256: '0'.repeat(64) }),
    (value: OfficeMaterialReceipt) => ({ ...value, path: '/not-a-public-input' }),
    (value: OfficeMaterialReceipt) => ({ ...value, stageRef: { fake: true } }),
    (value: OfficeMaterialReceipt) => ({ ...value, owner: { ...value.owner, path: '/private' } }),
  ]) {
    const upload = await uploadFixture(async request => mutate(receipt(request)))
    await expect(
      nativeOfficePrepareInput(target, selectedFile().file, context())
    ).rejects.toMatchObject({
      code: 'OFFICE_INPUT_UNCONFIRMED',
      operationId,
    })
    expect(
      upload.request.mock.calls.filter(([method]) => method === 'attachment/upload/finish')
    ).toHaveLength(1)
  }
})

test('a lost finish reply preserves the original operation and never automatically resends it', async () => {
  let accepted = 0
  const upload = await uploadFixture(async () => {
    accepted++
    throw new Error('lost acknowledgement')
  })
  await expect(
    nativeOfficePrepareInput(target, selectedFile().file, context())
  ).rejects.toMatchObject({
    code: 'OFFICE_INPUT_UNCONFIRMED',
    recovery: 'reconcile_original',
    operationId,
  })
  expect(accepted).toBe(1)
  expect(
    upload.request.mock.calls.filter(([method]) => method === 'attachment/upload/finish')
  ).toHaveLength(1)
  expect(upload.request.mock.calls.some(([method]) => method === 'attachment/delete')).toBe(false)
})

test('disposing the real target transport cancels its upload and prevents remaining chunks or finish', async () => {
  const upload = await uploadFixture()
  const transport = nativeOfficeTransport(target, scope, () => true, {
    prepareInput: nativeOfficePrepareInput,
  })
  const progress = vi.fn((bytes: number) => {
    if (bytes > 0) transport.dispose()
  })
  await expect(
    transport.prepareInput!(selectedFile(900_000).file, context(undefined, progress))
  ).rejects.toMatchObject({
    code: 'OFFICE_CANCELLED',
  })
  expect(
    upload.request.mock.calls.filter(([method]) => method === 'attachment/upload/chunk')
  ).toHaveLength(1)
  expect(
    upload.request.mock.calls.filter(([method]) => method === 'attachment/upload/cancel')
  ).toHaveLength(1)
  expect(upload.request.mock.calls.some(([method]) => method === 'attachment/upload/finish')).toBe(
    false
  )
  expect(upload.client.close).not.toHaveBeenCalled()
})

test('a late Office receipt after cancellation is discarded without deleting a durable material path', async () => {
  let finish!: () => void
  const entered = Promise.withResolvers<void>()
  const upload = await uploadFixture(
    request =>
      new Promise(resolve => {
        finish = () => resolve(receipt(request))
        entered.resolve()
      })
  )
  const cancel = new AbortController()
  const pending = nativeOfficePrepareInput(target, selectedFile().file, context(cancel.signal))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'OFFICE_CANCELLED', operationId })
  await entered.promise
  cancel.abort()
  finish()
  await rejected
  expect(upload.request.mock.calls.some(([method]) => method === 'attachment/delete')).toBe(false)
  expect(
    (upload.sessions as unknown as { attachmentByPath: Map<string, unknown> }).attachmentByPath.size
  ).toBe(0)
})

test('scope changes before finish or after an accepted reply reject the old identity without making a new task', async () => {
  for (const changeAt of [2, 3]) {
    const upload = await uploadFixture()
    let reads = 0
    fixture.request.mockImplementation(async () =>
      ++reads === changeAt ? { ...scope, identityGeneration: 'revoked' } : scope
    )
    await expect(
      nativeOfficePrepareInput(target, selectedFile().file, context())
    ).rejects.toMatchObject({ code: 'OFFICE_SCOPE_CHANGED', operationId })
    expect(
      upload.request.mock.calls.filter(([method]) => method === 'attachment/upload/finish')
    ).toHaveLength(changeAt === 2 ? 0 : 1)
    expect(
      upload.request.mock.calls.some(
        ([method]) => method.startsWith('thread/') || method.startsWith('turn/')
      )
    ).toBe(false)
  }
})

test('accepts an actual empty file hash but rejects oversized inputs before any upload', async () => {
  const upload = await uploadFixture()
  const empty = await nativeOfficePrepareInput(target, selectedFile(0).file, context())
  expect(empty).toMatchObject({ bytes: 0, sha256: createHash('sha256').digest('hex') })
  expect(upload.blocks).toHaveLength(0)
  const tooLarge = {
    size: 100 * 1024 * 1024 + 1,
    name: 'oversize.csv',
    type: 'text/csv',
    slice: vi.fn(),
  } as unknown as File
  const calls = fixture.invoke.mock.calls.length
  await expect(nativeOfficePrepareInput(target, tooLarge, context())).rejects.toMatchObject({
    code: 'OFFICE_INVALID_INPUT_METADATA',
  })
  expect(fixture.invoke).toHaveBeenCalledTimes(calls)
  expect(tooLarge.slice).not.toHaveBeenCalled()
})

test('the memory-only Office purpose cannot downgrade finish to a path or upgrade a legacy upload', async () => {
  const upload = await uploadFixture()
  const office = await upload.sessions.startAttachmentUpload({
    deviceId: target.serverId,
    workspacePath: target.workspacePath,
    filename: 'empty.csv',
    fileSize: 0,
    purpose: 'office_input',
  })
  await expect(
    upload.sessions.finishAttachmentUpload({ uploadId: office.uploadId })
  ).rejects.toThrow('OFFICE_INVALID_INPUT_METADATA')
  const legacy = await upload.sessions.startAttachmentUpload({
    filename: 'old-chat.csv',
    fileSize: 0,
  })
  await expect(
    upload.sessions.finishAttachmentUpload({
      uploadId: legacy.uploadId,
      office_input: {
        contractVersion: 'parallel-v1',
        requestId: 'original',
        operationId,
        scope,
        timeoutMs: 30000,
        payload: {},
      },
    })
  ).rejects.toThrow('OFFICE_INVALID_INPUT_METADATA')
  expect(upload.request.mock.calls.some(([method]) => method === 'attachment/upload/finish')).toBe(
    false
  )
  await upload.sessions.cancelAttachmentUpload({ uploadId: office.uploadId })
  await upload.sessions.cancelAttachmentUpload({ uploadId: legacy.uploadId })
})
