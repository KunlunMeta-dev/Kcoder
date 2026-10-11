import { invoke } from '@tauri-apps/api/core'
import { isValidFileSize, MAX_FILE_SIZE } from '@/api/attachments'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import {
  ATTACHMENT_CHUNK_BYTES,
  MAX_GATEWAY_ATTACHMENT_BYTES,
} from '@/kcoder/gatewayAttachmentTransfer'
import type { Attachment } from '@/types/api'

export interface LocalAttachmentApi {
  uploadAttachment: (
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal
  ) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
}

let localAttachmentIdSeed = 0

function nextLocalAttachmentId(): number {
  localAttachmentIdSeed += 1
  return -(Date.now() * 1000 + localAttachmentIdSeed)
}

function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.substring(dotIndex) : ''
}

function fileMimeType(file: File): string {
  return file.type || 'application/octet-stream'
}

function canReadTextLength(file: File): boolean {
  const mimeType = fileMimeType(file).toLowerCase()
  return mimeType.startsWith('text/') || fileExtension(file.name).toLowerCase() === '.txt'
}

async function maybeTextLength(file: File): Promise<number | null> {
  if (!canReadTextLength(file)) return null
  try {
    return (await file.text()).length
  } catch {
    return null
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0))
}

async function uploadGatewayFile(
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<{ path: string; deviceId: string }> {
  if (signal?.aborted) throw new Error('Upload cancelled')

  const started = await invoke<{ uploadId?: string; deviceId?: string }>(
    'start_local_attachment_upload',
    {
      filename: file.name,
      mimeType: fileMimeType(file),
      fileSize: file.size,
    }
  )
  const uploadId = typeof started.uploadId === 'string' ? started.uploadId : null
  if (!uploadId) throw new Error('KCoder 网关未返回附件上传 ID')

  try {
    onProgress?.(0)
    let index = 0
    for (let offset = 0; offset < file.size; offset += ATTACHMENT_CHUNK_BYTES) {
      if (signal?.aborted) throw new Error('Upload cancelled')
      await yieldToBrowser()
      const end = Math.min(offset + ATTACHMENT_CHUNK_BYTES, file.size)
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
      await yieldToBrowser()
      await invoke('append_local_attachment_upload', {
        uploadId,
        index,
        contentBase64: encodeBase64(bytes),
      })
      index += 1
      onProgress?.(Math.round((end / file.size) * 100))
    }

    if (signal?.aborted) throw new Error('Upload cancelled')
    const saved = await invoke<{ path?: string; deviceId?: string }>(
      'finish_local_attachment_upload',
      { uploadId }
    )
    if (!saved.path || !saved.deviceId) throw new Error('KCoder 网关未返回附件路径')
    return { path: saved.path, deviceId: saved.deviceId }
  } catch (error) {
    await invoke('cancel_local_attachment_upload', { uploadId }).catch(() => undefined)
    if (signal?.aborted) throw new Error('Upload cancelled', { cause: error })
    throw error
  }
}

export function createLocalAttachmentApi(): LocalAttachmentApi {
  return {
    async uploadAttachment(file, onProgress, signal) {
      if (!isValidFileSize(file.size) || file.size > MAX_GATEWAY_ATTACHMENT_BYTES) {
        throw new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB`)
      }
      if (!isTauriRuntime()) {
        throw new Error('Local attachment storage requires the desktop app')
      }
      if (signal?.aborted) throw new Error('Upload cancelled')

      if (isKCoderGatewayPage()) {
        const saved = await uploadGatewayFile(file, onProgress, signal)
        const textLength = await maybeTextLength(file)
        return {
          id: nextLocalAttachmentId(),
          filename: file.name,
          file_size: file.size,
          mime_type: fileMimeType(file),
          status: 'ready',
          text_length: textLength,
          file_extension: fileExtension(file.name),
          created_at: new Date().toISOString(),
          local_path: saved.path,
          local_preview_url: saved.path,
          runtime_device_id: saved.deviceId,
        }
      }

      onProgress?.(0)
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      if (signal?.aborted) throw new Error('Upload cancelled')
      const saved = await invoke<string | { path: string; deviceId: string }>(
        'save_local_attachment_file',
        {
          workspacePath: null,
          filename: file.name,
          mimeType: fileMimeType(file),
          fileSize: file.size,
          bytes,
        }
      )
      if (signal?.aborted) throw new Error('Upload cancelled')
      const localPath = typeof saved === 'string' ? saved : saved.path
      const runtimeDeviceId = typeof saved === 'string' ? undefined : saved.deviceId
      onProgress?.(100)

      const textLength = await maybeTextLength(file)
      return {
        id: nextLocalAttachmentId(),
        filename: file.name,
        file_size: file.size,
        mime_type: fileMimeType(file),
        status: 'ready',
        text_length: textLength,
        file_extension: fileExtension(file.name),
        created_at: new Date().toISOString(),
        local_path: localPath,
        local_preview_url: localPath,
        ...(runtimeDeviceId ? { runtime_device_id: runtimeDeviceId } : {}),
      }
    },
    async deleteAttachment() {
      // Draft files are intentionally left in place so already-sent runtime tasks
      // can continue to resolve the absolute paths stored in their transcript.
    },
  }
}
