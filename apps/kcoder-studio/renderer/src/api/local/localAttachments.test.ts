import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAttachmentApi } from './localAttachments'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

describe('local attachment API', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
    document.head.innerHTML = ''
  })

  test('stores uploaded files under executor home instead of the active project workspace', async () => {
    tauriMocks.invoke.mockResolvedValue(
      '/Users/me/.wegent-executor/workspace/attachments/draft/123/photo.png'
    )
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
    const progress = vi.fn()

    const api = createLocalAttachmentApi()
    const uploadWithLegacyContext = api.uploadAttachment as (
      file: File,
      onProgress?: (progress: number) => void,
      context?: { workspacePath?: string | null }
    ) => Promise<Awaited<ReturnType<typeof api.uploadAttachment>>>

    const attachment = await uploadWithLegacyContext(file, progress, {
      workspacePath: '/Users/me/project',
    })

    expect(tauriMocks.invoke).toHaveBeenCalledWith('save_local_attachment_file', {
      workspacePath: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      fileSize: 3,
      bytes: [1, 2, 3],
    })
    expect(progress).toHaveBeenNthCalledWith(1, 0)
    expect(progress).toHaveBeenNthCalledWith(2, 100)
    expect(attachment.local_path).toBe(
      '/Users/me/.wegent-executor/workspace/attachments/draft/123/photo.png'
    )
  })

  test('rejects an oversized gateway file before reading it into browser memory', async () => {
    document.head.innerHTML = '<meta name="kcoder-rpc-token" content="token">'
    const file = new File([new Uint8Array(100 * 1024 * 1024 + 1)], 'large.bin')
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer')

    await expect(createLocalAttachmentApi().uploadAttachment(file)).rejects.toThrow('100 MB')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(tauriMocks.invoke).not.toHaveBeenCalled()
  })

  test('keeps the Gateway device capability returned with a staged attachment', async () => {
    tauriMocks.invoke.mockResolvedValue({ path: '/tmp/photo.png', deviceId: 'server-b' })
    const attachment = await createLocalAttachmentApi().uploadAttachment(
      new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' })
    )

    expect(attachment).toMatchObject({
      local_path: '/tmp/photo.png',
      local_preview_url: '/tmp/photo.png',
      runtime_device_id: 'server-b',
    })
  })

  test('streams Gateway Web uploads in chunks to keep the renderer responsive', async () => {
    document.head.innerHTML = '<meta name="kcoder-rpc-token" content="token">'
    const chunkCalls: unknown[] = []
    tauriMocks.invoke.mockImplementation(async (command: string, payload: unknown) => {
      if (command === 'start_local_attachment_upload') {
        return { uploadId: 'upload-1', deviceId: 'server-b' }
      }
      if (command === 'append_local_attachment_upload') {
        chunkCalls.push(payload)
        return { receivedBytes: chunkCalls.length }
      }
      if (command === 'finish_local_attachment_upload') {
        return { path: '/tmp/photo.png', deviceId: 'server-b' }
      }
      return undefined
    })
    const file = new File([new Uint8Array(192 * 1024 * 2 + 1)], 'photo.png', {
      type: 'image/png',
    })
    const progress = vi.fn()

    const attachment = await createLocalAttachmentApi().uploadAttachment(file, progress)

    expect(tauriMocks.invoke).toHaveBeenCalledWith('start_local_attachment_upload', {
      filename: 'photo.png',
      mimeType: 'image/png',
      fileSize: file.size,
    })
    expect(chunkCalls).toHaveLength(3)
    expect(tauriMocks.invoke).toHaveBeenCalledWith('finish_local_attachment_upload', {
      uploadId: 'upload-1',
    })
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      'save_local_attachment_file',
      expect.anything()
    )
    expect(progress).toHaveBeenCalledWith(0)
    expect(progress).toHaveBeenLastCalledWith(100)
    expect(attachment.runtime_device_id).toBe('server-b')
  })
})
