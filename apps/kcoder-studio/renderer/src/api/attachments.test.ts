import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { deleteAttachment, uploadAttachment } from './attachments'

const originalCreateObjectUrl = URL.createObjectURL

const httpMocks = vi.hoisted(() => ({
  createHttpClient: vi.fn(),
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({
    appBasePath: '',
    apiBaseUrl: '/api',
    socketBaseUrl: '',
    socketPath: '/socket.io',
    cloudDeviceScalingWikiUrl: '',
  }),
}))

vi.mock('./http', () => ({
  createHttpClient: httpMocks.createHttpClient,
}))

function mockClient(overrides = {}) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

describe('attachment API', () => {
  beforeEach(() => {
    httpMocks.createHttpClient.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    URL.createObjectURL = originalCreateObjectUrl
  })

  function uploadFixture() {
    class Xhr extends EventTarget {
      upload = new EventTarget()
      status = 200
      responseText = JSON.stringify({ id: 7, filename: 'image.png', status: 'ready', file_size: 5, mime_type: 'image/png' })
      open = vi.fn()
      send = vi.fn()
      setRequestHeader = vi.fn()
      abort() { this.dispatchEvent(new Event('abort')) }
    }
    const xhr = new Xhr()
    vi.stubGlobal('XMLHttpRequest', class { constructor() { return xhr } })
    return xhr
  }

  test('uploads with browser progress and preserves the local image preview', async () => {
    const xhr = uploadFixture()
    URL.createObjectURL = vi.fn(() => 'blob:uploaded-image-preview')
    const progress = vi.fn()
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    const pending = uploadAttachment(file, progress)
    xhr.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 5, total: 5 }))
    xhr.dispatchEvent(new Event('load'))
    const attachment = await pending
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/attachments/upload')
    expect((xhr.send.mock.calls[0][0] as FormData).get('file')).toBe(file)
    expect(progress).toHaveBeenCalledExactlyOnceWith(100)
    expect(attachment).toMatchObject({ id: 7, file_extension: '.png', local_preview_url: 'blob:uploaded-image-preview', subtask_id: null })
    expect(URL.createObjectURL).toHaveBeenCalledWith(file)
  })

  test('cancellation rejects and ignores late completion and progress', async () => {
    const xhr = uploadFixture()
    URL.createObjectURL = vi.fn()
    const controller = new AbortController()
    const progress = vi.fn()
    const pending = uploadAttachment(new File(['image'], 'image.png'), progress, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    xhr.dispatchEvent(new Event('load'))
    xhr.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 5, total: 5 }))
    await rejected
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })

  test('does not send a stored legacy token when uploading through Gateway', async () => {
    const xhr = uploadFixture()
    const gatewayMarker = document.createElement('meta')
    gatewayMarker.name = 'kcoder-rpc-token'
    gatewayMarker.content = 'cookie'
    document.head.append(gatewayMarker)
    localStorage.setItem('auth_token', 'legacy-token')

    try {
      const pending = uploadAttachment(new File(['text'], 'note.txt', { type: 'text/plain' }))
      xhr.dispatchEvent(new Event('load'))
      await pending
      expect(xhr.setRequestHeader).not.toHaveBeenCalled()
    } finally {
      gatewayMarker.remove()
      localStorage.removeItem('auth_token')
    }
  })

  test('deletes through the shared HTTP client', async () => {
    const deleteRequest = vi.fn().mockResolvedValue(undefined)
    httpMocks.createHttpClient.mockReturnValue(mockClient({ delete: deleteRequest }))

    await deleteAttachment(12)

    expect(httpMocks.createHttpClient).toHaveBeenCalledWith({ baseUrl: '/api' })
    expect(deleteRequest).toHaveBeenCalledWith('/attachments/12')
  })
})
