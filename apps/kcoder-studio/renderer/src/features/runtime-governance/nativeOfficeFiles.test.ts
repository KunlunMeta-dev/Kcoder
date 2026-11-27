import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  IntegrationRequest,
  IntegrationScope,
  OfficeArtifactManifest,
  OfficeExportReceipt,
} from '../../../../shared/generated/contracts'
import { GatewayRemoteSessions } from '@/kcoder/gatewayRemoteSessions'
import type { GatewayClient } from '@/kcoder/gatewayRuntimeTypes'
import { downloadGatewayAttachment } from '@/kcoder/gatewayAttachmentTransfer'
const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  invoke: vi.fn(),
  download: vi.fn(),
  host: undefined as { download: ReturnType<typeof vi.fn> } | undefined,
}))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({ invokeRuntimeCommand: fixture.invoke }))
vi.mock('@/kcoder/downloadLink', () => ({ downloadLink: fixture.download }))
vi.mock('@/kcoder/desktopHost', () => ({ desktopHost: () => fixture.host }))
import { nativeOfficeReadExport } from './nativeOfficeFiles'

const scope: IntegrationScope = {
  accountId: 'owned-account',
  targetId: 'native-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const target = { serverId: 'selected-ssh', workspacePath: '/owned-workspace' }
let blob: Blob | undefined
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn((value: Blob) => {
      blob = value
      return 'blob:owned-office'
    }),
    revokeObjectURL: vi.fn(),
  })
})
afterEach(() => {
  fixture.request.mockReset()
  fixture.invoke.mockReset()
  fixture.download.mockReset()
  fixture.host = undefined
  blob = undefined
  vi.unstubAllGlobals()
})
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
async function facts(size = 4096) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
  bytes[0] = 80
  bytes[1] = 75
  const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')
  const manifest: OfficeArtifactManifest = {
    schemaVersion: 1,
    id: 'artifact-native',
    revision: 1,
    owner: { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null },
    task: { threadId: 'actual-owned-thread', turnId: 'actual-completed-turn' },
    kind: 'document',
    title: 'Actual native document',
    format: 'docx',
    bytes: size,
    sha256,
    sourceRefs: [],
    createdAtMs: 1,
    verification: {
      status: 'partial',
      completedChecks: ['ooxml_structure'],
      pendingChecks: ['reader'],
      readerStatus: 'unavailable',
      formulaCalculation: 'not_applicable',
    },
  }
  const receipt: OfficeExportReceipt = {
    schemaVersion: 1,
    exportId: 'actual-native-export',
    reference: { id: manifest.id, revision: 1 },
    filename: 'native-report.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: size,
    sha256,
    leaseRevision: 'actual-lease-r1',
    expiresAtMs: Date.now() + 60_000,
  }
  fixture.request.mockImplementation(async (_method, params) =>
    params.method === 'integrations/scope/read' ? scope : reply(params.params, { manifest })
  )
  fixture.invoke.mockResolvedValue({ contentBase64: encode(bytes), size })
  return { bytes, manifest, receipt }
}
function reply(request: IntegrationRequest, result: Record<string, unknown>) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: null,
    entityRevision: null,
    observedAt: '2026-10-24T00:00:00Z',
    status: 'completed',
    error: null,
    result,
  }
}
function context(signal = new AbortController().signal) {
  return { target, scope, signal }
}

test('reads opaque bytes through the existing same-target remote attachment path and reports browser request only', async () => {
  const { bytes, receipt } = await facts()
  const result = await nativeOfficeReadExport(receipt, context())
  expect(fixture.invoke).toHaveBeenCalledWith(
    'read_local_attachment_file',
    {
      deviceId: target.serverId,
      workspacePath: target.workspacePath,
      threadId: 'actual-owned-thread',
      path: 'office-export:actual-native-export:actual-lease-r1',
      mimeType: receipt.mediaType,
    },
    { signal: expect.any(AbortSignal) }
  )
  expect(result).toMatchObject({
    status: 'download_requested',
    bytes: bytes.length,
    sha256: receipt.sha256,
  })
  expect(fixture.download).toHaveBeenCalledOnce()
  expect(blob?.size).toBe(bytes.length)
  expect(Buffer.from(await blob!.arrayBuffer())).toEqual(Buffer.from(bytes))
  expect(
    fixture.request.mock.calls.filter(call => call[1].method === 'integrations/scope/read')
  ).toHaveLength(2)
})

test('automation acknowledges only verified bytes and keeps download separate from an unknown acknowledgement', async () => {
  const { receipt, manifest } = await facts()
  let confirmed = true
  fixture.request.mockImplementation(async (_method, params) => {
    if (params.method === 'integrations/scope/read') return scope
    if (params.method === 'integrations/artifact/read') return reply(params.params, { manifest })
    if (!confirmed) throw new Error('original acknowledgement reply lost')
    return {
      ...reply(params.params, {
        exportId: receipt.exportId,
        reference: receipt.reference,
        acknowledgement: 'client_acknowledged',
        claim: {
          owner: manifest.owner,
          runId: 'original-automation-run',
          nativeOperationId: 'original-core-operation',
          manifestRef: {
            kind: 'artifact',
            id: receipt.reference.id,
            revision: String(receipt.reference.revision),
          },
          exportId: receipt.exportId,
          bytes: receipt.bytes,
          sha256: receipt.sha256,
          completedAtMs: Date.now(),
        },
      }),
      operationId: params.params.operationId,
    }
  })
  const result = await nativeOfficeReadExport(receipt, {
    ...context(),
    automationRunId: 'original-automation-run',
  })
  expect(result).toMatchObject({ status: 'download_requested', acknowledgement: 'confirmed' })
  const acknowledgements = fixture.request.mock.calls.filter(
    call => call[1].method === 'integrations/artifact/acknowledgeExport'
  )
  expect(acknowledgements).toHaveLength(1)
  expect(acknowledgements[0][1].params.payload).toMatchObject({
    exportId: receipt.exportId,
    leaseRevision: receipt.leaseRevision,
    automationRunId: 'original-automation-run',
    bytes: receipt.bytes,
    sha256: receipt.sha256,
  })
  confirmed = false
  const unknown = await nativeOfficeReadExport(receipt, {
    ...context(),
    automationRunId: 'original-automation-run',
  })
  expect(unknown).toMatchObject({ status: 'download_requested', acknowledgement: 'unconfirmed' })
  expect(fixture.download).toHaveBeenCalledTimes(2)
})

test('reuses actual GatewayAttachmentTransfer 256KiB fallback and checks all decoded chunk bytes before Blob creation', async () => {
  const { bytes, receipt } = await facts(460_000)
  const requests: { method: string; params: Record<string, unknown>; signal?: AbortSignal }[] = []
  const client = new EventTarget() as GatewayClient
  client.connect = async () => {}
  client.close = () => {}
  client.request = async <T>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { signal?: AbortSignal }
  ) => {
    requests.push({ method, params, signal: options?.signal })
    if (method === 'attachment/read')
      throw new Error('attachment response exceeds 256 KiB; use chunks')
    const offset = params.offset as number
    const chunk = bytes.slice(offset, offset + (params.length as number))
    return {
      offset,
      size: chunk.length,
      totalSize: bytes.length,
      eof: offset + chunk.length === bytes.length,
      contentBase64: encode(chunk),
    } as T
  }
  const getClient = vi.fn(async () => client)
  const sessions = new GatewayRemoteSessions({
    resolveServer: async () => ({
      id: target.serverId,
      label: 'Owned',
      transport: 'ssh',
      workspacePath: target.workspacePath,
    }),
    commandClient: getClient,
  })
  fixture.invoke.mockImplementation(async (_command, params, options) =>
    sessions.readAttachment({ ...params, signal: options.signal })
  )
  const result = await nativeOfficeReadExport(receipt, context())
  expect(result?.status).toBe('download_requested')
  expect(getClient).toHaveBeenCalledWith(
    expect.objectContaining({ id: target.serverId }),
    target.workspacePath
  )
  expect(requests.map(value => value.method)).toEqual([
    'attachment/read',
    'attachment/read/chunk',
    'attachment/read/chunk',
    'attachment/read/chunk',
  ])
  expect(
    requests.every(
      value =>
        value.params.threadId === 'actual-owned-thread' &&
        value.params.path === 'office-export:actual-native-export:actual-lease-r1' &&
        value.signal instanceof AbortSignal
    )
  ).toBe(true)
  expect(Buffer.from(await blob!.arrayBuffer())).toEqual(Buffer.from(bytes))
  await sessions.dispose()
})

test('never falls back on a source denial and does not download or create a Blob', async () => {
  const { receipt } = await facts()
  fixture.invoke.mockRejectedValue(new Error('OFFICE_ACCESS_DENIED'))
  await expect(nativeOfficeReadExport(receipt, context())).rejects.toThrow()
  expect(fixture.invoke).toHaveBeenCalledOnce()
  expect(blob).toBeUndefined()
  expect(fixture.download).not.toHaveBeenCalled()
})

test('rejects expired/pathlike receipts, mismatched source owner, truncated bytes and full SHA corruption', async () => {
  const { receipt, bytes, manifest } = await facts()
  for (const wrong of [
    { ...receipt, expiresAtMs: Date.now() - 1 },
    { ...receipt, filename: '../private.docx' },
    { ...receipt, exportId: 'fake:extra' },
  ])
    await expect(nativeOfficeReadExport(wrong, context())).rejects.toMatchObject({
      code: 'OFFICE_EXPORT_RECEIPT_INVALID',
    })
  fixture.request.mockImplementation(async (_method, params) =>
    params.method === 'integrations/scope/read'
      ? scope
      : reply(params.params, {
          manifest: { ...manifest, owner: { ...manifest.owner, accountId: 'other-owner' } },
        })
  )
  await expect(nativeOfficeReadExport(receipt, context())).rejects.toMatchObject({
    code: 'OFFICE_EXPORT_RECEIPT_INVALID',
  })
  fixture.request.mockImplementation(async (_method, params) =>
    params.method === 'integrations/scope/read' ? scope : reply(params.params, { manifest })
  )
  fixture.invoke.mockResolvedValue({ contentBase64: encode(bytes.slice(1)), size: receipt.bytes })
  await expect(nativeOfficeReadExport(receipt, context())).rejects.toMatchObject({
    code: 'OFFICE_CONTENT_IDENTITY_MISMATCH',
  })
  const corrupt = bytes.slice()
  corrupt[100] ^= 1
  fixture.invoke.mockResolvedValue({ contentBase64: encode(corrupt), size: receipt.bytes })
  await expect(nativeOfficeReadExport(receipt, context())).rejects.toMatchObject({
    code: 'OFFICE_CONTENT_IDENTITY_MISMATCH',
  })
  expect(fixture.download).not.toHaveBeenCalled()
})

test('current target/scope changes after byte transfer discard the file before any save request', async () => {
  const { receipt, manifest } = await facts()
  let scopes = 0
  fixture.request.mockImplementation(async (_method, params) =>
    params.method === 'integrations/scope/read'
      ? ++scopes === 1
        ? scope
        : { ...scope, identityGeneration: 'new-native-owner' }
      : reply(params.params, { manifest })
  )
  await expect(nativeOfficeReadExport(receipt, context())).rejects.toMatchObject({
    code: 'OFFICE_SCOPE_CHANGED',
  })
  expect(fixture.download).not.toHaveBeenCalled()
})

test('desktop bridge distinguishes completed, cancelled and interrupted without browser fallback', async () => {
  const { receipt } = await facts()
  for (const status of ['completed', 'cancelled', 'interrupted'] as const) {
    fixture.host = { download: vi.fn(async () => ({ status, filename: receipt.filename })) }
    const result = await nativeOfficeReadExport(receipt, context())
    expect(result?.status).toBe(status)
    expect(fixture.host.download).toHaveBeenCalledWith({
      url: 'blob:owned-office',
      filename: receipt.filename,
    })
  }
  fixture.host = {
    download: vi.fn(async () => {
      throw new Error('native interruption')
    }),
  }
  expect((await nativeOfficeReadExport(receipt, context()))?.status).toBe('interrupted')
  expect(fixture.download).not.toHaveBeenCalled()
})

test('an aborted transfer never starts saving even if the underlying reader replies late', async () => {
  const { receipt, bytes } = await facts()
  const abort = new AbortController()
  fixture.invoke.mockImplementation(async () => {
    abort.abort()
    return { contentBase64: encode(bytes), size: bytes.length }
  })
  await expect(nativeOfficeReadExport(receipt, context(abort.signal))).rejects.toMatchObject({
    code: 'OFFICE_CANCELLED',
  })
  expect(fixture.download).not.toHaveBeenCalled()
})

test('the existing transfer never retries a denied or cancelled read and stops after an aborted chunk', async () => {
  for (const phase of ['denied', 'direct-cancel', 'chunk-cancel']) {
    const cancel = new AbortController()
    const calls: string[] = []
    const client = new EventTarget() as GatewayClient
    client.request = async <T>(method: string) => {
      calls.push(method)
      if (phase === 'denied') throw new Error('OFFICE_ACCESS_DENIED')
      if (method === 'attachment/read') {
        if (phase === 'direct-cancel') cancel.abort()
        throw new Error('attachment response exceeds 256 KiB; use chunks')
      }
      cancel.abort()
      return {
        contentBase64: 'UEsA',
        offset: 0,
        size: 3,
        totalSize: 6,
        eof: false,
      } as T
    }
    await expect(
      downloadGatewayAttachment(client, 'actual-thread', 'office-export:owned:1', {
        signal: cancel.signal,
      })
    ).rejects.toThrow(phase === 'denied' ? 'OFFICE_ACCESS_DENIED' : undefined)
    expect(calls).toEqual(
      phase === 'chunk-cancel' ? ['attachment/read', 'attachment/read/chunk'] : ['attachment/read']
    )
  }
})

function ordinaryByteReceipt(receipt: OfficeExportReceipt, manifest: OfficeArtifactManifest) {
  return {
    schemaVersion: 1,
    kind: 'office_export_acknowledgement',
    operationId: `export-ack-${receipt.exportId}`,
    owner: manifest.owner,
    task: manifest.task,
    exportId: receipt.exportId,
    reference: receipt.reference,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    sourceIdentities: [],
    readCompletedAtMs: 1000,
    acknowledgedAtMs: 1001,
  }
}
test('ordinary exact bytes produce a typed byte ACK without claiming a saved file', async () => {
  const { receipt, manifest, bytes } = await facts()
  const ordinary = ordinaryByteReceipt(receipt, manifest)
  fixture.request.mockImplementation(async (_method, params) => {
    if (params.method === 'integrations/scope/read') return scope
    if (params.method === 'integrations/artifact/read') return reply(params.params, { manifest })
    expect(fixture.invoke).toHaveBeenCalledOnce()
    return {
      ...reply(params.params, {
        exportId: receipt.exportId,
        reference: receipt.reference,
        acknowledgement: 'client_acknowledged',
        receipt: ordinary,
      }),
      operationId: ordinary.operationId,
    }
  })
  const result = await nativeOfficeReadExport(receipt, context())
  expect(result).toMatchObject({
    status: 'download_requested',
    acknowledgement: 'confirmed',
    bytes: bytes.length,
  })
  expect(result).not.toHaveProperty('saved')
  expect(result).not.toHaveProperty('viewed')
  const acks = fixture.request.mock.calls.filter(
    call => call[1].method === 'integrations/artifact/acknowledgeExport'
  )
  expect(acks).toHaveLength(1)
  expect(acks[0][1].params.payload).toEqual({
    exportId: receipt.exportId,
    leaseRevision: receipt.leaseRevision,
    reference: receipt.reference,
    bytes: bytes.length,
    sha256: receipt.sha256,
  })
  expect(fixture.download).toHaveBeenCalledOnce()
})
test('a lost ordinary ACK reads only the original operation and downloads once', async () => {
  const { receipt, manifest } = await facts()
  const ordinary = ordinaryByteReceipt(receipt, manifest)
  fixture.request.mockImplementation(async (_method, params) => {
    if (params.method === 'integrations/scope/read') return scope
    if (params.method === 'integrations/artifact/read') return reply(params.params, { manifest })
    if (params.method === 'integrations/artifact/acknowledgeExport')
      throw new Error('original ACK response lost')
    expect(params.method).toBe('integrations/office/readOperation')
    expect(params.params.payload).toEqual({ operationId: ordinary.operationId })
    return reply(params.params, {
      operationId: ordinary.operationId,
      method: 'office.acknowledgeExport',
      phase: 'completed',
      result: ordinary,
    })
  })
  expect(await nativeOfficeReadExport(receipt, context())).toMatchObject({
    status: 'download_requested',
    acknowledgement: 'confirmed',
  })
  expect(
    fixture.request.mock.calls.filter(
      call => call[1].method === 'integrations/artifact/acknowledgeExport'
    )
  ).toHaveLength(1)
  expect(
    fixture.request.mock.calls.filter(
      call => call[1].method === 'integrations/office/readOperation'
    )
  ).toHaveLength(1)
  expect(fixture.invoke).toHaveBeenCalledOnce()
  expect(fixture.download).toHaveBeenCalledOnce()
})
test.each(['target', 'profile', 'abort', 'selected-task'] as const)(
  'late original ACK readback after %s change cannot start a download',
  async change => {
    const { receipt, manifest } = await facts()
    const ordinary = ordinaryByteReceipt(receipt, manifest)
    const abort = new AbortController()
    const ownedTarget = { ...target }
    const ownedScope = structuredClone(scope)
    let selectedTaskCurrent = true
    let resolveRead!: (value: unknown) => void
    let readRequest: IntegrationRequest | undefined
    fixture.request.mockImplementation(async (_method, params) => {
      if (params.method === 'integrations/scope/read') return scope
      if (params.method === 'integrations/artifact/read') return reply(params.params, { manifest })
      if (params.method === 'integrations/artifact/acknowledgeExport') throw new Error('lost ACK')
      readRequest = params.params
      return new Promise(resolve => {
        resolveRead = resolve
      })
    })
    const pending = nativeOfficeReadExport(receipt, {
      target: ownedTarget,
      scope: ownedScope,
      signal: abort.signal,
      isCurrent: () => selectedTaskCurrent,
    })
    const outcome = pending.then(
      value => ({ value }),
      error => ({ error })
    )
    await vi.waitFor(() => expect(readRequest).toBeDefined())
    if (change === 'target') ownedTarget.serverId = 'another-current-target'
    else if (change === 'profile') ownedScope.accountId = 'another-current-profile'
    else if (change === 'abort') abort.abort()
    else selectedTaskCurrent = false
    resolveRead(
      reply(readRequest!, {
        operationId: ordinary.operationId,
        method: 'office.acknowledgeExport',
        phase: 'completed',
        result: ordinary,
      })
    )
    expect(await outcome).toMatchObject({
      error: { code: change === 'abort' ? 'OFFICE_CANCELLED' : 'OFFICE_SCOPE_CHANGED' },
    })
    expect(fixture.download).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(
      fixture.request.mock.calls.filter(
        call => call[1].method === 'integrations/artifact/acknowledgeExport'
      )
    ).toHaveLength(1)
  }
)

test('an unavailable ordinary capability keeps persistence unconfirmed and never claims saved', async () => {
  const { receipt, manifest } = await facts()
  fixture.request.mockImplementation(async (_method, params) => {
    if (params.method === 'integrations/scope/read') return scope
    if (params.method === 'integrations/artifact/read') return reply(params.params, { manifest })
    throw new Error('INTEGRATION_TARGET_UPGRADE_REQUIRED')
  })
  const result = await nativeOfficeReadExport(receipt, context())
  expect(result).toMatchObject({ status: 'download_requested', acknowledgement: 'unconfirmed' })
  expect(result).not.toHaveProperty('saved')
  expect(result).not.toHaveProperty('persisted')
  expect(fixture.download).toHaveBeenCalledOnce()
  expect(
    fixture.request.mock.calls.filter(
      call => call[1].method === 'integrations/artifact/acknowledgeExport'
    )
  ).toHaveLength(1)
})
test('corrupt received bytes never issue ordinary ACK or operation reconciliation', async () => {
  const { receipt, bytes } = await facts()
  const changed = bytes.slice()
  changed[changed.length - 1] ^= 1
  fixture.invoke.mockResolvedValue({ contentBase64: encode(changed), size: changed.length })
  await expect(nativeOfficeReadExport(receipt, context())).rejects.toMatchObject({
    code: 'OFFICE_CONTENT_IDENTITY_MISMATCH',
  })
  expect(
    fixture.request.mock.calls.filter(call =>
      ['integrations/artifact/acknowledgeExport', 'integrations/office/readOperation'].includes(
        call[1].method
      )
    )
  ).toHaveLength(0)
  expect(fixture.download).not.toHaveBeenCalled()
})
