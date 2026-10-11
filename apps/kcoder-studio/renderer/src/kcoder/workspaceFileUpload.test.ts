import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { notifyAccountContextChange } from './accountContextEvents'
import { uploadWorkspaceFile } from './workspaceFileUpload'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const request = vi.mocked(requestLocalExecutor)
const hash = 'a'.repeat(64)
function file(size = 192 * 1024 + 37) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
  return {
    bytes,
    file: {
      name: 'owned.bin',
      size,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => bytes.slice(start, end).buffer,
      }),
    } as File,
  }
}
function setup(size: number) {
  request.mockImplementation(async (_method, input) => {
    const params = input as { method: string }
    if (params.method === 'attachment/upload/start')
      return { upload_id: 'owned-upload', scopeToken: 'owned-client' }
    if (params.method === 'attachment/upload/finish') return { path: '/private/owned-attachment' }
    if (params.method === 'workspace/file/importAttachment')
      return {
        status: 'uploaded',
        name: 'owned.bin',
        path: '/workspace/destination/owned.bin',
        size,
        sha256: hash,
        revision: null,
      }
    return {}
  })
}
const methods = () => request.mock.calls.map(([, input]) => (input as { method: string }).method)
beforeEach(() => {
  request.mockReset()
})

test('sends multiple exact binary chunks and accepts a complete committed receipt', async () => {
  const fixture = file()
  setup(fixture.file.size)
  const progress = vi.fn()
  const result = await uploadWorkspaceFile(
    'upload-device',
    '/workspace',
    '/workspace/destination',
    fixture.file,
    { onProgress: progress }
  )
  expect(result.status).toBe('uploaded')
  const chunks = request.mock.calls
    .filter(([, input]) => (input as { method: string }).method === 'attachment/upload/chunk')
    .map(([, input]) => (input as { params: { index: number; content_base64: string } }).params)
  expect(chunks.map(chunk => chunk.index)).toEqual([0, 1])
  expect(
    chunks.flatMap(chunk =>
      Array.from(atob(chunk.content_base64), character => character.charCodeAt(0))
    )
  ).toEqual(Array.from(fixture.bytes))
  expect(progress.mock.calls).toEqual([
    [192 * 1024, fixture.file.size],
    [fixture.file.size, fixture.file.size],
  ])
  expect(methods()).not.toContain('attachment/delete')
  for (const [, input] of request.mock.calls.slice(1))
    expect(input).toMatchObject({ expectedScopeToken: 'owned-client' })
})

test('cancelled chunks release the original staged upload and never import a file', async () => {
  const fixture = file()
  setup(fixture.file.size)
  const abort = new AbortController()
  await expect(
    uploadWorkspaceFile('upload-device', '/workspace', '/workspace/destination', fixture.file, {
      signal: abort.signal,
      onProgress: () => abort.abort(),
    })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(methods()).toContain('attachment/upload/cancel')
  expect(methods()).not.toContain('workspace/file/importAttachment')
})

test.each([false, true])(
  'same-name conflict decision %s preserves the captured revision',
  async overwrite => {
    const fixture = file(8)
    setup(fixture.file.size)
    const original = request.getMockImplementation()!
    let imports = 0
    request.mockImplementation(async (method, input) => {
      if (
        (input as { method: string }).method === 'workspace/file/importAttachment' &&
        imports++ === 0
      )
        return {
          status: 'conflict',
          name: 'owned.bin',
          path: '/workspace/destination/owned.bin',
          size: 19,
          sha256: '',
          revision: `stat:${hash}`,
        }
      return original(method, input)
    })
    const action = uploadWorkspaceFile(
      'upload-device',
      '/workspace',
      '/workspace/destination',
      fixture.file,
      { onConflict: async () => overwrite }
    )
    if (overwrite) {
      await expect(action).resolves.toMatchObject({ status: 'uploaded' })
      const imported = request.mock.calls.filter(
        ([, input]) => (input as { method: string }).method === 'workspace/file/importAttachment'
      )
      expect((imported[1][1] as { params: unknown }).params).toMatchObject({
        overwrite: true,
        expectedRevision: `stat:${hash}`,
      })
    } else {
      await expect(action).rejects.toMatchObject({ name: 'AbortError' })
      expect(methods()).toContain('attachment/delete')
      expect(imports).toBe(1)
    }
  }
)

test('rejects a mismatched success receipt instead of reporting completion', async () => {
  const fixture = file(8)
  setup(9)
  await expect(
    uploadWorkspaceFile('upload-device', '/workspace', '/workspace/destination', fixture.file)
  ).rejects.toThrow(/invalid|无效/)
  expect(methods()).toContain('attachment/delete')
})

test('account replacement never sends old resource identities into the new owner', async () => {
  const fixture = file(8)
  let started!: (value: unknown) => void
  request.mockImplementation(
    () =>
      new Promise(resolve => {
        started = resolve
      })
  )
  const pending = uploadWorkspaceFile(
    'account-upload-device',
    '/workspace',
    '/workspace/destination',
    fixture.file
  )
  notifyAccountContextChange('account-upload-device')
  started({ upload_id: 'old-account-upload', scopeToken: 'old-client' })
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(methods()).toEqual(['attachment/upload/start'])
})
