import { invoke } from '@tauri-apps/api/core'
import type { NativeSelectedFileRead } from '@/types/native-file-read'
export interface SelectedDeliveryFile {
  file: File
  relativePath: string
}
export interface SelectedFileReadOptions {
  signal?: AbortSignal
}

export async function readSelectedDeliveryFiles(
  paths: string[],
  { signal }: SelectedFileReadOptions = {}
): Promise<SelectedDeliveryFile[]> {
  signal?.throwIfAborted()
  const readId = crypto.randomUUID()
  const close = () => invoke<void>('cancel_dropped_file_read', { readId })
  const abort = () => {
    void close().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  let finished = false
  try {
    let selected: NativeSelectedFileRead
    try {
      selected = await invoke<NativeSelectedFileRead>('begin_dropped_file_read', { readId, paths })
    } catch (error) {
      if (/command.*(not found|unknown)|unknown.*command/i.test(String(error)))
        throw new Error(
          'Native file import requires an updated desktop application with chunked file reads',
          { cause: error }
        )
      throw error
    }
    signal?.throwIfAborted()
    if (
      !Number.isSafeInteger(selected.chunkBytes) ||
      selected.chunkBytes < 1 ||
      selected.chunkBytes > 262144 ||
      selected.files.length > 512
    )
      throw new Error('Invalid native file read metadata')
    let total = 0
    for (const file of selected.files) {
      total += file.size
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > 100 * 1024 * 1024 ||
        total > 512 * 1024 * 1024
      )
        throw new Error('Native selected-file size budget exceeded')
    }
    const files: SelectedDeliveryFile[] = []
    for (const [fileIndex, metadata] of selected.files.entries()) {
      const chunks: ArrayBuffer[] = []
      for (let offset = 0; offset < metadata.size;) {
        signal?.throwIfAborted()
        const bytes = await invoke<ArrayBuffer>('read_dropped_file_chunk', {
          readId,
          fileIndex,
          offset,
        })
        signal?.throwIfAborted()
        const expected = Math.min(selected.chunkBytes, metadata.size - offset)
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== expected)
          throw new Error('Invalid native selected-file chunk')
        chunks.push(bytes)
        offset += bytes.byteLength
      }
      files.push({ file: new File(chunks, metadata.name), relativePath: metadata.relativePath })
    }
    finished = true
    return files
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    window.dispatchEvent(
      new CustomEvent('kcoder:native-file-read-error', {
        detail: {
          message,
          upgrade: /updated desktop application/.test(message),
        },
      })
    )
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    if (finished) await close()
    else await close().catch(() => {})
  }
}
export async function readDroppedFiles(
  paths: string[],
  options?: SelectedFileReadOptions
): Promise<File[]> {
  return (await readSelectedDeliveryFiles(paths, options)).map(item => item.file)
}
