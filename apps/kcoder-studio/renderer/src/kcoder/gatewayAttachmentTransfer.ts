import type { GatewayClient } from './gatewayRuntimeTypes'

export const MAX_GATEWAY_ATTACHMENT_BYTES = 100 * 1024 * 1024

const MAX_DIRECT_ATTACHMENT_BYTES = 256 * 1024
export const ATTACHMENT_CHUNK_BYTES = 192 * 1024

interface GatewayAttachmentSaveResult {
  path?: unknown
}

interface GatewayAttachmentReadResult {
  contentBase64?: unknown
  size?: unknown
}

interface GatewayAttachmentReadChunkResult {
  contentBase64?: unknown
  offset?: unknown
  size?: unknown
  totalSize?: unknown
  eof?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeBytes(values: unknown[]): Uint8Array {
  if (values.length > MAX_GATEWAY_ATTACHMENT_BYTES) {
    throw new Error('附件不能超过 100 MB')
  }
  const bytes = new Uint8Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 255) {
      throw new Error('附件内容必须是 0 到 255 的整数')
    }
    bytes[index] = Number(value)
  }
  return bytes
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function decodeBase64(contentBase64: string): Uint8Array {
  let binary: string
  try {
    binary = atob(contentBase64)
  } catch {
    throw new Error('附件内容不是有效的 base64')
  }
  if (binary.length > MAX_GATEWAY_ATTACHMENT_BYTES) {
    throw new Error('附件不能超过 100 MB')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function base64ToByteValues(contentBase64: string): number[] {
  return Array.from(decodeBase64(contentBase64))
}

function isDirectReadLimitError(error: unknown): boolean {
  const message = errorMessage(error)
  return message.includes('256 KiB') || message.includes('response limit')
}

export async function uploadGatewayAttachment(
  client: GatewayClient,
  filename: string,
  values: unknown[]
): Promise<{ path: string; contentBase64: string }> {
  const bytes = normalizeBytes(values)
  if (bytes.length <= MAX_DIRECT_ATTACHMENT_BYTES) {
    const contentBase64 = encodeBytes(bytes)
    const result = await client.request<GatewayAttachmentSaveResult>('attachment/save', {
      filename,
      content_base64: contentBase64,
    })
    const path = typeof result.path === 'string' && result.path.trim() ? result.path : null
    if (!path) throw new Error('KCoder app-server 未返回附件路径')
    return { path, contentBase64 }
  }

  const started = await client.request<{ upload_id?: unknown }>('attachment/upload/start', {
    filename,
    size: bytes.length,
  })
  const uploadId =
    typeof started.upload_id === 'string' && started.upload_id.trim() ? started.upload_id : null
  if (!uploadId) throw new Error('KCoder app-server 未返回附件上传 ID')

  let contentBase64 = ''
  try {
    let index = 0
    for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
      const encoded = encodeBytes(bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES))
      await client.request('attachment/upload/chunk', {
        upload_id: uploadId,
        index,
        content_base64: encoded,
      })
      contentBase64 += encoded
      index += 1
    }
    const result = await client.request<GatewayAttachmentSaveResult>('attachment/upload/finish', {
      upload_id: uploadId,
    })
    const path = typeof result.path === 'string' && result.path.trim() ? result.path : null
    if (!path) throw new Error('KCoder app-server 未返回附件路径')
    return { path, contentBase64 }
  } catch (error) {
    try {
      await client.request('attachment/upload/cancel', { upload_id: uploadId })
    } catch {
      // Cleanup failure after an upload failure must not replace the original upload error.
    }
    throw error
  }
}

async function readAttachmentInChunks(
  client: GatewayClient,
  threadId: string,
  path: string
): Promise<{ contentBase64: string; size: number }> {
  let offset = 0
  let totalSize: number | null = null
  let contentBase64 = ''

  while (true) {
    const result = await client.request<GatewayAttachmentReadChunkResult>('attachment/read/chunk', {
      threadId,
      path,
      offset,
      length: ATTACHMENT_CHUNK_BYTES,
    })
    const chunkBase64 = typeof result.contentBase64 === 'string' ? result.contentBase64 : null
    const chunkOffset = typeof result.offset === 'number' ? result.offset : null
    const chunkSize = typeof result.size === 'number' ? result.size : null
    const reportedTotal = typeof result.totalSize === 'number' ? result.totalSize : null
    if (
      chunkBase64 === null ||
      chunkOffset !== offset ||
      chunkSize === null ||
      chunkSize < 0 ||
      chunkSize > ATTACHMENT_CHUNK_BYTES ||
      reportedTotal === null ||
      reportedTotal < 0 ||
      reportedTotal > MAX_GATEWAY_ATTACHMENT_BYTES
    ) {
      throw new Error('KCoder app-server 返回了无效的附件分块')
    }
    if (totalSize !== null && totalSize !== reportedTotal) {
      throw new Error('KCoder app-server 返回的附件大小不一致')
    }
    totalSize = reportedTotal
    if (decodeBase64(chunkBase64).length !== chunkSize) {
      throw new Error('KCoder app-server 返回的附件分块大小不一致')
    }
    contentBase64 += chunkBase64
    offset += chunkSize
    if (result.eof === true) break
    if (chunkSize === 0 || offset >= totalSize) {
      throw new Error('KCoder app-server 未正确结束附件下载')
    }
  }

  if (totalSize === null || offset !== totalSize) {
    throw new Error('KCoder app-server 返回的附件内容不完整')
  }
  return { contentBase64, size: totalSize }
}

export async function downloadGatewayAttachment(
  client: GatewayClient,
  threadId: string,
  path: string
): Promise<{ contentBase64: string; size: number }> {
  try {
    const result = await client.request<GatewayAttachmentReadResult>('attachment/read', {
      threadId,
      path,
    })
    const contentBase64 = typeof result.contentBase64 === 'string' ? result.contentBase64 : null
    if (contentBase64 === null) throw new Error('KCoder app-server 未返回附件内容')
    const size = typeof result.size === 'number' ? result.size : decodeBase64(contentBase64).length
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GATEWAY_ATTACHMENT_BYTES) {
      throw new Error('KCoder app-server 返回了无效的附件大小')
    }
    return { contentBase64, size }
  } catch (error) {
    if (!isDirectReadLimitError(error)) throw error
    return readAttachmentInChunks(client, threadId, path)
  }
}
