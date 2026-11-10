import { downloadLink } from './downloadLink'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type {
  HistoricalAttachmentReceipt,
  MigrationHistoryAttachmentChunkResult,
} from '../../../shared/generated/contracts'
interface Sink {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}
interface SavePicker {
  showSaveFilePicker?: (options: {
    suggestedName: string
  }) => Promise<{ createWritable: () => Promise<Sink> }>
}
const maximum = 256 * 1024 * 1024
export async function downloadMigrationAttachment(
  receipt: HistoricalAttachmentReceipt,
  name: string,
  read: (offset: number, signal: AbortSignal) => Promise<MigrationHistoryAttachmentChunkResult>,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  isCurrent: () => boolean
) {
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new DOMException('Cancelled', 'AbortError')
  }
  check()
  if (
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 0 ||
    receipt.bytes > maximum ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    throw new Error('history_attachment_invalid_receipt')
  const safeName =
    Array.from(name.split(/[\\/]/).at(-1) || '')
      .map(c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '_' : c))
      .join('') || 'attachment.bin'
  const picker = (globalThis as SavePicker).showSaveFilePicker
  let sink: Sink | undefined
  const parts: Uint8Array<ArrayBuffer>[] = []
  try {
    if (typeof picker === 'function') {
      const handle = await picker.call(globalThis, { suggestedName: safeName })
      check()
      sink = await handle.createWritable()
      check()
    }
    const hash = sha256.create()
    let offset = 0
    onProgress(0)
    while (offset < receipt.bytes) {
      check()
      const value = await read(offset, signal)
      check()
      const raw = atob(value.dataBase64)
      if (raw.length > 256 * 1024) throw new Error('history_attachment_invalid_chunk')
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      const end = offset + bytes.length
      if (
        value.offset !== offset ||
        bytes.length === 0 ||
        end > receipt.bytes ||
        value.receipt.attachmentId !== receipt.attachmentId ||
        value.receipt.sha256 !== receipt.sha256 ||
        value.receipt.bytes !== receipt.bytes ||
        value.receipt.chunkBytes !== receipt.chunkBytes ||
        value.nextOffset !== (end < receipt.bytes ? end : null) ||
        bytesToHex(sha256(bytes)) !== value.dataSha256
      )
        throw new Error('history_attachment_invalid_chunk')
      hash.update(bytes)
      if (sink) {
        await sink.write(bytes)
        check()
      } else {
        parts.push(bytes)
      }
      offset = end
      onProgress(offset)
    }
    check()
    if (bytesToHex(hash.digest()) !== receipt.sha256)
      throw new Error('history_attachment_content_changed')
    if (sink) {
      await sink.close()
      sink = undefined
    } else {
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = safeName
      anchor.rel = 'noopener'
      anchor.hidden = true
      document.body.appendChild(anchor)
      try {
        await downloadLink(anchor)
      } finally {
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 0)
      }
    }
  } catch (error) {
    if (sink)
      try {
        await sink.abort()
      } catch {
        /* The original transfer failure remains authoritative. */
      }
    throw error
  } finally {
    parts.length = 0
  }
}
