import { expect, test, vi } from 'vitest'
import { GatewayRemoteSessions } from './gatewayRemoteSessions'
import type { GatewayClient } from './gatewayRuntimeTypes'
import type { GatewayServer } from './gatewayRpc'

const server: GatewayServer = {
  id: 'owned-target',
  label: 'Owned fixture',
  transport: 'local',
  workspacePath: '/owned',
}
function fixture(request: ReturnType<typeof vi.fn>) {
  const client = {
    request,
    close: vi.fn(),
    supportsExperimental: () => true,
  } as unknown as GatewayClient
  const sessions = new GatewayRemoteSessions({
    resolveServer: async () => server,
    commandClient: async () => client,
  })
  return { sessions, client }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('cancellation before start returns cleans only its late remote upload identity', async () => {
  let resolve!: (value: unknown) => void
  const request = vi.fn((method: string) =>
    method === 'attachment/upload/start'
      ? new Promise(done => {
          resolve = done
        })
      : Promise.resolve({})
  )
  const { sessions, client } = fixture(request)
  const controller = new AbortController()
  const pending = sessions.startAttachmentUpload({
    filename: 'owned.bin',
    fileSize: 3,
    signal: controller.signal,
  })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await tick()
  controller.abort()
  resolve({ upload_id: 'late-owned-upload' })
  await rejected
  expect(request).toHaveBeenCalledWith('attachment/upload/cancel', {
    upload_id: 'late-owned-upload',
  })
  expect(client.close).not.toHaveBeenCalled()
  sessions.dispose()
})

test('cancelling a stalled chunk aborts that transfer while a peer upload can finish', async () => {
  let starts = 0
  const request = vi.fn(
    (method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (method === 'attachment/upload/start')
        return Promise.resolve({ upload_id: `remote-${++starts}` })
      if (method === 'attachment/upload/chunk' && params.upload_id === 'remote-1')
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        )
      if (method === 'attachment/upload/finish')
        return Promise.resolve({ path: '/private/peer.bin' })
      return Promise.resolve({})
    }
  )
  const { sessions, client } = fixture(request)
  const controller = new AbortController()
  const first = await sessions.startAttachmentUpload({
    filename: 'first.bin',
    fileSize: 3,
    signal: controller.signal,
  })
  const peer = await sessions.startAttachmentUpload({ filename: 'peer.bin', fileSize: 3 })
  const pending = sessions.appendAttachmentUpload({
    uploadId: first.uploadId,
    index: 0,
    contentBase64: 'AQID',
  })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  await sessions.appendAttachmentUpload({
    uploadId: peer.uploadId,
    index: 0,
    contentBase64: 'BAUG',
  })
  await expect(sessions.finishAttachmentUpload({ uploadId: peer.uploadId })).resolves.toMatchObject(
    { path: '/private/peer.bin' }
  )
  expect(request.mock.calls.filter(([method]) => method === 'attachment/upload/cancel')).toEqual([
    ['attachment/upload/cancel', { upload_id: 'remote-1' }],
  ])
  expect(client.close).not.toHaveBeenCalled()
  sessions.dispose()
})

test('a finish receipt arriving after cancel is cleaned and never becomes a draft attachment', async () => {
  let resolve!: (value: unknown) => void
  const request = vi.fn((method: string) => {
    if (method === 'attachment/upload/start') return Promise.resolve({ upload_id: 'owned-upload' })
    if (method === 'attachment/upload/finish')
      return new Promise(done => {
        resolve = done
      })
    return Promise.resolve({})
  })
  const { sessions } = fixture(request)
  const controller = new AbortController()
  const upload = await sessions.startAttachmentUpload({
    filename: 'owned.bin',
    fileSize: 3,
    signal: controller.signal,
  })
  await sessions.appendAttachmentUpload({
    uploadId: upload.uploadId,
    index: 0,
    contentBase64: 'AQID',
  })
  const pending = sessions.finishAttachmentUpload({ uploadId: upload.uploadId })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  resolve({ path: '/private/owned-finished.bin' })
  await rejected
  expect(request).toHaveBeenCalledWith('attachment/delete', { path: '/private/owned-finished.bin' })
  await expect(
    sessions.readAttachment({ deviceId: server.id, path: '/private/owned-finished.bin' })
  ).rejects.toThrow()
  sessions.dispose()
})
