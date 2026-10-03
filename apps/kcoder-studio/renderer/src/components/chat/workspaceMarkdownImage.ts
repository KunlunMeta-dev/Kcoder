import type { WorkspaceFileChunkResponse } from '@/types/workspace-files'

export const MAX_WORKSPACE_MARKDOWN_IMAGE_BYTES = 25 * 1024 * 1024

type ReadWorkspaceFileChunk = (
  deviceId: string,
  path: string,
  offset: number
) => Promise<WorkspaceFileChunkResponse>

function decodeWorkspaceImageChunk(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export function workspaceImageMimeType(path: string): string {
  const extension = path.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase()
  return (
    {
      avif: 'image/avif',
      gif: 'image/gif',
      heic: 'image/heic',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    }[extension ?? ''] ?? 'application/octet-stream'
  )
}

export async function readWorkspaceMarkdownImage(
  readChunk: ReadWorkspaceFileChunk,
  deviceId: string,
  absolutePath: string
): Promise<Blob> {
  const mimeType = workspaceImageMimeType(absolutePath)
  if (!mimeType.startsWith('image/')) throw new Error('Workspace file is not an image')

  const chunks: Uint8Array[] = []
  let offset = 0
  let expectedSize: number | null = null
  let expectedModifiedAt: string | null | undefined
  for (;;) {
    const chunk = await readChunk(deviceId, absolutePath, offset)
    if (chunk.offset !== offset || chunk.size < offset) {
      throw new Error('Workspace image chunk response is inconsistent')
    }
    expectedSize ??= chunk.size
    if (offset === 0) expectedModifiedAt = chunk.modifiedAt
    if (chunk.size !== expectedSize || chunk.modifiedAt !== expectedModifiedAt) {
      throw new Error('Workspace image changed while it was being read')
    }
    if (chunk.size > MAX_WORKSPACE_MARKDOWN_IMAGE_BYTES) {
      throw new Error('Workspace image exceeds the preview limit')
    }
    const bytes = decodeWorkspaceImageChunk(chunk.contentBase64)
    if (!chunk.eof && bytes.byteLength === 0) {
      throw new Error('Workspace image chunk did not advance')
    }
    chunks.push(bytes)
    offset += bytes.byteLength
    if (offset > chunk.size || offset > MAX_WORKSPACE_MARKDOWN_IMAGE_BYTES) {
      throw new Error('Workspace image response exceeds its declared size')
    }
    if (chunk.eof) {
      if (offset !== chunk.size) throw new Error('Workspace image response ended early')
      break
    }
  }
  return new Blob(chunks.map(chunk => chunk.slice().buffer), { type: mimeType })
}
