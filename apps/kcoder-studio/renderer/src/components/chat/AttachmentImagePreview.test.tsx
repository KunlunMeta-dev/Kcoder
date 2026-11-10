import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import { AttachmentImagePreview } from './AttachmentImagePreview'

const runtimeCommandMock = vi.hoisted(() => ({
  clientResourceUrl: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isGateway: vi.fn(() => false),
}))

vi.mock('@/lib/client-resource-url', () => runtimeCommandMock)
vi.mock('@/lib/runtime-environment', async original => ({
  ...(await original<typeof import('@/lib/runtime-environment')>()),
  isGatewayRuntime: runtimeCommandMock.isGateway,
}))
vi.mock('@/lib/runtime-commands', () => ({ invoke: runtimeCommandMock.invoke }))


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
    runtimeCommandMock.clientResourceUrl.mockImplementation(
      (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
    )
    runtimeCommandMock.invoke.mockResolvedValue(true)
    runtimeCommandMock.isGateway.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    runtimeCommandMock.clientResourceUrl.mockReset()
    runtimeCommandMock.invoke.mockReset()
    runtimeCommandMock.isGateway.mockReset()
  })

  test('does not retry an invoke failure when the attachment object is rebuilt with the same preview identity', async () => {
    runtimeCommandMock.isGateway.mockReturnValue(true)
    runtimeCommandMock.invoke.mockResolvedValue(false)
    const attachment = createAttachment(901, '/tmp/attachment-preview-invoke-failure.png')
    const { rerender } = render(
      <AttachmentImagePreview attachment={attachment} {...previewProps} />
    )

    expect(await screen.findByTestId('attachment-preview-error')).toBeInTheDocument()
    expect(runtimeCommandMock.invoke).toHaveBeenCalledTimes(1)
    expect(runtimeCommandMock.invoke).toHaveBeenCalledWith('local_path_exists', {
      path: attachment.local_preview_url,
    })

    rerender(<AttachmentImagePreview attachment={{ ...attachment }} {...previewProps} />)

    expect(runtimeCommandMock.invoke).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('attachment-preview-error')).toBeInTheDocument()
    expect(runtimeCommandMock.clientResourceUrl).not.toHaveBeenCalled()
  })

  test('retries after a conversion failure when the preview identity changes', async () => {
    const firstAttachment = createAttachment(902, '/tmp/attachment-preview-conversion-failure.png')
    const secondAttachment = createAttachment(902, '/tmp/attachment-preview-conversion-retry.png')
    runtimeCommandMock.clientResourceUrl
      .mockImplementationOnce(() => {
        throw new Error('clientResourceUrl unavailable')
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
    expect(runtimeCommandMock.clientResourceUrl).toHaveBeenNthCalledWith(
      1,
      firstAttachment.local_preview_url
    )
    expect(runtimeCommandMock.clientResourceUrl).toHaveBeenNthCalledWith(
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
