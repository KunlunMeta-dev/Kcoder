import { expect, test, vi } from 'vitest'
import { GatewayRemoteSessions } from './gatewayRemoteSessions'
import type { GatewayClient } from './gatewayRuntimeTypes'
import type { GatewayServer } from './gatewayRpc'
import { RuntimeInputRejectedError } from './rpcOutcome'

const server: GatewayServer = {
  id: 'owned',
  label: 'Fixture',
  transport: 'local',
  workspacePath: '/owned',
}
const draftPath = `/private/draft-attachments/d-${'a'.repeat(64)}/content/photo.png`
const settings = { instructions: '', personality: 'pragmatic' as const }
const execution = {
  attachments: [{ local_path: draftPath, runtime_thread_id: 'thread-a', mime_type: 'image/png' }],
}

function fixture(options: { durable?: boolean; denyRetain?: boolean; path?: string } = {}) {
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'attachment/upload/start') return { upload_id: 'upload-owned' }
      if (method === 'attachment/upload/finish') return { path: '/private/upload/photo.png' }
      if (method === 'gateway/attachments/retain') {
        if (options.denyRetain) throw new Error('Draft owner changed')
        return {
          retained: true,
          drafts: [{ sourcePath: (params.paths as string[])[0], path: options.path ?? draftPath }],
        }
      }
      if (method === 'attachment/read') return { contentBase64: 'AQID', size: 3 }
      return {}
    }
  )
  const client = {
    request,
    close: vi.fn(),
    supportsExperimental: () => options.durable !== false,
  } as unknown as GatewayClient
  const commandClient = vi.fn(async () => client)
  const taskClient = vi.fn(async () => client)
  const sessions = new GatewayRemoteSessions({
    resolveServer: async () => server,
    commandClient,
    taskClient,
  })
  return { sessions, client, request, commandClient, taskClient }
}

test('existing-task uploads retain bytes with that task client before exposing a queue attachment', async () => {
  const { sessions, request, commandClient, taskClient } = fixture()
  const started = await sessions.startAttachmentUpload({
    filename: 'photo.png',
    fileSize: 3,
    threadId: 'thread-a',
  })
  await sessions.appendAttachmentUpload({
    uploadId: started.uploadId,
    index: 0,
    contentBase64: 'AQID',
  })
  await expect(sessions.finishAttachmentUpload({ uploadId: started.uploadId })).resolves.toEqual({
    path: draftPath,
    deviceId: 'owned',
    threadId: 'thread-a',
  })
  expect(taskClient).toHaveBeenCalledWith(server, '/owned', 'thread-a')
  expect(commandClient).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledWith('gateway/attachments/retain', {
    threadId: 'thread-a',
    paths: ['/private/upload/photo.png'],
    durable: true,
  })
  sessions.dispose()
})

test.each([draftPath, `C:\\private\\draft-attachments\\d-${'b'.repeat(64)}\\content\\photo.png`])(
  'a new page revalidates and recovers draft %s without uploading again',
  async path => {
    const { sessions, client, request } = fixture({ path })
    const prompt = await sessions.promptWithAttachmentsForClient(
      '',
      { attachments: [{ ...execution.attachments[0], local_path: path }] },
      server,
      client,
      settings,
      'thread-a'
    )
    expect(prompt).toContain(JSON.stringify(path).slice(1, -1))
    expect(prompt).toContain('"filename":"photo.png"')
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'gateway/attachments/retain',
      'attachment/read',
    ])
    sessions.dispose()
  }
)

test.each([{ durable: false }, { denyRetain: true }, { path: '/tmp/unretained.png' }])(
  'unsupported, revoked or unconfirmed draft recovery is a pre-admission rejection: %j',
  async options => {
    const { sessions, client, request } = fixture(options)
    await expect(
      sessions.promptWithAttachmentsForClient('', execution, server, client, settings, 'thread-a')
    ).rejects.toBeInstanceOf(RuntimeInputRejectedError)
    expect(request.mock.calls.map(([method]) => method)).not.toContain('attachment/read')
    expect(request.mock.calls.map(([method]) => method)).not.toContain('attachment/save')
    sessions.dispose()
  }
)

test('a sent draft preview reads its history alias on the owning task connection without re-retaining', async () => {
  const { sessions, request, commandClient, taskClient } = fixture()
  const started = await sessions.startAttachmentUpload({
    filename: 'photo.png', fileSize: 3, threadId: 'thread-a',
  })
  await sessions.appendAttachmentUpload({ uploadId: started.uploadId, index: 0, contentBase64: 'AQID' })
  await sessions.finishAttachmentUpload({ uploadId: started.uploadId })
  request.mockClear()
  request.mockImplementation(async method => {
    if (method === 'gateway/attachments/retain') throw new Error('Draft has been consumed')
    if (method === 'attachment/read') return { contentBase64: 'AQID', size: 3 }
    throw new Error(`Unexpected method: ${method}`)
  })
  await expect(sessions.readAttachment({
    deviceId: 'owned', threadId: 'thread-a', path: draftPath, mimeType: 'image/png',
  })).resolves.toMatchObject({ contentBase64: 'AQID', mimeType: 'image/png' })
  expect(taskClient).toHaveBeenLastCalledWith(server, '/owned', 'thread-a')
  expect(commandClient).not.toHaveBeenCalled()
  expect(request.mock.calls.map(([method]) => method)).toEqual(['attachment/read'])
  sessions.dispose()
})

test('a saved draft cannot be rebound to another task', async () => {
  const { sessions, client, request } = fixture()
  await expect(
    sessions.promptWithAttachmentsForClient('', execution, server, client, settings, 'thread-b')
  ).rejects.toBeInstanceOf(RuntimeInputRejectedError)
  expect(request).not.toHaveBeenCalled()
  sessions.dispose()
})

test('a cached draft is recovered again when its task connection has been replaced', async () => {
  const { sessions, request, taskClient } = fixture()
  const started = await sessions.startAttachmentUpload({
    filename: 'photo.png', fileSize: 0, threadId: 'thread-a',
  })
  await sessions.finishAttachmentUpload({ uploadId: started.uploadId })
  request.mockClear()
  const replacementRequest = vi.fn(request.getMockImplementation()!)
  taskClient.mockResolvedValue({ request: replacementRequest } as unknown as GatewayClient)
  await sessions.readAttachment({ deviceId: 'owned', threadId: 'thread-a', path: draftPath })
  expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
    'gateway/attachments/retain', 'attachment/read',
  ])
  expect(request).not.toHaveBeenCalled()
  sessions.dispose()
})

test('a new socket on the same client recovers the draft, while an unrelated client close leaves it alone', async () => {
  const { sessions, request, client } = fixture()
  let connectionId = 'rpc-1-1'
  Object.defineProperty(client, 'diagnosticConnection', { get: () => ({ connectionId }) })
  const started = await sessions.startAttachmentUpload({ filename: 'photo.png', fileSize: 0, threadId: 'thread-a' })
  await sessions.finishAttachmentUpload({ uploadId: started.uploadId })
  request.mockClear()
  sessions.handleCommandClientClose('owned', {} as GatewayClient)
  await sessions.readAttachment({ deviceId: 'owned', threadId: 'thread-a', path: draftPath })
  expect(request.mock.calls.map(([method]) => method)).toEqual(['attachment/read'])
  request.mockClear()
  connectionId = 'rpc-1-2'
  await sessions.readAttachment({ deviceId: 'owned', threadId: 'thread-a', path: draftPath })
  expect(request.mock.calls.map(([method]) => method)).toEqual(['gateway/attachments/retain', 'attachment/read'])
  sessions.dispose()
})

test('cancelling while Native retains a draft never hands it to the queue', async () => {
  const { sessions, client, request } = fixture()
  let finishRetention!: (value: unknown) => void
  request.mockImplementation(async (method, params) => {
    if (method === 'attachment/upload/start') return { upload_id: 'upload-owned' }
    if (method === 'attachment/upload/finish') return { path: '/private/upload/photo.png' }
    if (method === 'gateway/attachments/retain')
      return new Promise(resolve => {
        finishRetention = resolve
      })
    return { params }
  })
  const controller = new AbortController()
  const started = await sessions.startAttachmentUpload({
    filename: 'photo.png',
    fileSize: 0,
    threadId: 'thread-a',
    signal: controller.signal,
  })
  const finished = sessions.finishAttachmentUpload({ uploadId: started.uploadId })
  const rejected = expect(finished).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(finishRetention).toBeTypeOf('function'))
  controller.abort()
  finishRetention({
    retained: true,
    drafts: [{ sourcePath: '/private/upload/photo.png', path: draftPath }],
  })
  await rejected
  expect(request).toHaveBeenCalledWith('attachment/delete', { path: draftPath })
  expect(client.close).not.toHaveBeenCalled()
  sessions.dispose()
})
