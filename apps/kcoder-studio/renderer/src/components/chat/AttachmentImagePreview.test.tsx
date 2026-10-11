import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import { AttachmentImagePreview } from './AttachmentImagePreview'

const tauriCoreMock = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)

const previewProps = {
  buttonTestId: 'attachment-preview-button',
  imageTestId: 'attachment-preview-image',
  loadingTestId: 'attachment-preview-loading',
  errorTestId: 'attachment-preview-error',
  imageClassName: 'preview-image',
  placeholderClassName: 'preview-placeholder',
  disableLightbox: true,
}

function createAttachment(id: number, localPreviewUrl: string): Attachment {
  return {
    id,
    filename: `preview-${id}.png`,
    file_size: 1024,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-07-29T00:00:00.000Z',
    local_preview_url: localPreviewUrl,
  }
}

describe('AttachmentImagePreview', () => {
  beforeEach(() => {
    tauriCoreMock.convertFileSrc.mockImplementation(
      (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
    )
    tauriCoreMock.invoke.mockResolvedValue(true)
    tauriCoreMock.isTauri.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    tauriCoreMock.convertFileSrc.mockReset()
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.isTauri.mockReset()
  })

  test('does not retry an invoke failure when the attachment object is rebuilt with the same preview identity', async () => {
    tauriCoreMock.isTauri.mockReturnValue(true)
    tauriCoreMock.invoke.mockResolvedValue(false)
    const attachment = createAttachment(901, '/tmp/attachment-preview-invoke-failure.png')
    const { rerender } = render(
      <AttachmentImagePreview attachment={attachment} {...previewProps} />
    )

    expect(await screen.findByTestId('attachment-preview-error')).toBeInTheDocument()
    expect(tauriCoreMock.invoke).toHaveBeenCalledTimes(1)
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith('local_path_exists', {
      path: attachment.local_preview_url,
    })

    rerender(<AttachmentImagePreview attachment={{ ...attachment }} {...previewProps} />)

    expect(tauriCoreMock.invoke).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('attachment-preview-error')).toBeInTheDocument()
    expect(tauriCoreMock.convertFileSrc).not.toHaveBeenCalled()
  })

  test('retries after a conversion failure when the preview identity changes', async () => {
    const firstAttachment = createAttachment(902, '/tmp/attachment-preview-conversion-failure.png')
    const secondAttachment = createAttachment(902, '/tmp/attachment-preview-conversion-retry.png')
    tauriCoreMock.convertFileSrc
      .mockImplementationOnce(() => {
        throw new Error('convertFileSrc unavailable')
      })
      .mockImplementation((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`)
    const { rerender } = render(
      <AttachmentImagePreview attachment={firstAttachment} {...previewProps} />
    )

    expect(await screen.findByTestId('attachment-preview-error')).toBeInTheDocument()

    rerender(<AttachmentImagePreview attachment={secondAttachment} {...previewProps} />)

    expect(await screen.findByTestId('attachment-preview-image')).toHaveAttribute(
      'src',
      'asset://localhost/tmp/attachment-preview-conversion-retry.png'
    )
    expect(tauriCoreMock.convertFileSrc).toHaveBeenNthCalledWith(
      1,
      firstAttachment.local_preview_url
    )
    expect(tauriCoreMock.convertFileSrc).toHaveBeenNthCalledWith(
      2,
      secondAttachment.local_preview_url
    )
  })

  test('allows the same preview path to load again after an image error and remount', async () => {
    const attachment = createAttachment(903, '/tmp/attachment-preview-image-error.png')
    const firstRender = render(<AttachmentImagePreview attachment={attachment} {...previewProps} />)
    const firstImage = await screen.findByTestId('attachment-preview-image')

    fireEvent.error(firstImage)

    expect(await screen.findByTestId('attachment-preview-error')).toBeInTheDocument()
    firstRender.rerender(
      <AttachmentImagePreview attachment={{ ...attachment }} {...previewProps} />
    )
    expect(screen.queryByTestId('attachment-preview-image')).not.toBeInTheDocument()

    firstRender.unmount()
    render(<AttachmentImagePreview attachment={{ ...attachment }} {...previewProps} />)

    expect(await screen.findByTestId('attachment-preview-image')).toHaveAttribute(
      'src',
      'asset://localhost/tmp/attachment-preview-image-error.png'
    )
  })
})
