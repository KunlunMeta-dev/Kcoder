import { describe, expect, test, vi } from 'vitest'
import {
  MAX_WORKSPACE_MARKDOWN_IMAGE_BYTES,
  readWorkspaceMarkdownImage,
} from './workspaceMarkdownImage'

describe('readWorkspaceMarkdownImage', () => {
  test('assembles consistent chunks into an image Blob', async () => {
    const readChunk = vi
      .fn()
      .mockResolvedValueOnce({
        path: '/workspace/image.png',
        name: 'image.png',
        contentBase64: 'aW1h',
        offset: 0,
        size: 5,
        eof: false,
        modifiedAt: '100',
      })
      .mockResolvedValueOnce({
        path: '/workspace/image.png',
        name: 'image.png',
        contentBase64: 'Z2U=',
        offset: 3,
        size: 5,
        eof: true,
        modifiedAt: '100',
      })

    const blob = await readWorkspaceMarkdownImage(readChunk, 'device-a', '/workspace/image.png')

    expect(blob.type).toBe('image/png')
    expect(await blob.text()).toBe('image')
    expect(readChunk).toHaveBeenNthCalledWith(2, 'device-a', '/workspace/image.png', 3)
  })

  test('rejects a file modified between chunks even when its size is unchanged', async () => {
    const readChunk = vi
      .fn()
      .mockResolvedValueOnce({
        contentBase64: 'aW1h', offset: 0, size: 5, eof: false, modifiedAt: '100',
      })
      .mockResolvedValueOnce({
        contentBase64: 'Z2U=', offset: 3, size: 5, eof: true, modifiedAt: '101',
      })

    await expect(
      readWorkspaceMarkdownImage(readChunk, 'device-a', '/workspace/image.png')
    ).rejects.toThrow('changed while it was being read')
  })

  test('rejects oversized images before decoding their content', async () => {
    const readChunk = vi.fn().mockResolvedValue({
      contentBase64: '',
      offset: 0,
      size: MAX_WORKSPACE_MARKDOWN_IMAGE_BYTES + 1,
      eof: true,
      modifiedAt: null,
    })

    await expect(
      readWorkspaceMarkdownImage(readChunk, 'device-a', '/workspace/image.png')
    ).rejects.toThrow('exceeds the preview limit')
  })

  test('rejects an empty non-final chunk so the loop cannot stall', async () => {
    const readChunk = vi.fn().mockResolvedValue({
      contentBase64: '', offset: 0, size: 1, eof: false, modifiedAt: null,
    })

    await expect(
      readWorkspaceMarkdownImage(readChunk, 'device-a', '/workspace/image.png')
    ).rejects.toThrow('did not advance')
    expect(readChunk).toHaveBeenCalledTimes(1)
  })
})
