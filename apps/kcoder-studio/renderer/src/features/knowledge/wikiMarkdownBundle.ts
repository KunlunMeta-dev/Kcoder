import JSZip from 'jszip'
import i18n from '@/i18n'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_PAGE_BYTES = 256 * 1024
const MAX_PAGES = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INVALID_NAME = /[\p{C}<>:"/\\|?*]/u
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

type Page = {
  pageId: string
  baseRevision: string
  name: string
  title: string
  body: string
}
type Bundle = {
  format: 'kcoder-wiki-markdown'
  version: 1
  libraryId: string
  pages: Page[]
}
type ManifestPage = Omit<Page, 'body'> & { filename: string }
type Manifest = Omit<Bundle, 'pages'> & { pages: ManifestPage[] }
type EntryInfo = { name: string; crc: number; size: number }
type Stream = {
  on(event: 'data' | 'error' | 'end', callback: (value?: unknown) => void): Stream
  pause(): Stream
  resume(): Stream
}

function invalid(): Error {
  return new Error(i18n.t('knowledge:invalidMarkdownBundle'))
}
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw invalid()
}
function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value))
  const actual = Object.keys(value)
  requireValid(actual.length === keys.length && actual.every(key => keys.includes(key)))
}
function text(value: unknown): asserts value is string {
  requireValid(typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value))
}
function validate(value: unknown, zipped: boolean): Bundle | Manifest {
  record(value, ['format', 'version', 'libraryId', 'pages'])
  requireValid(value.format === 'kcoder-wiki-markdown' && value.version === 1)
  text(value.libraryId)
  requireValid(UUID.test(value.libraryId))
  requireValid(
    Array.isArray(value.pages) && value.pages.length > 0 && value.pages.length <= MAX_PAGES
  )
  const ids = new Set<string>()
  const filenames = new Set<string>()
  for (const page of value.pages) {
    record(page, ['pageId', 'baseRevision', 'name', 'title', zipped ? 'filename' : 'body'])
    for (const key of Object.keys(page)) text(page[key])
    const { pageId, baseRevision, name, title } = page as Record<string, string>
    requireValid(UUID.test(pageId) && UUID.test(baseRevision) && name === `${pageId}.md`)
    requireValid(!ids.has(pageId) && title.trim() && [...title].length <= 240)
    ids.add(pageId)
    if (zipped) {
      const filename = page.filename as string
      requireValid(flatName(filename) && filename.endsWith(`--${pageId}.md`))
      const prefix = filename.slice(0, -`--${pageId}.md`.length)
      requireValid([...prefix].length > 0 && [...prefix].length <= 40)
      const folded = filename.normalize('NFC').toLowerCase()
      requireValid(!filenames.has(folded))
      filenames.add(folded)
    } else {
      const body = page.body as string
      requireValid(body.trim() && encoder.encode(body).length <= MAX_PAGE_BYTES)
    }
  }
  return value as unknown as Bundle | Manifest
}
function flatName(name: string): boolean {
  return name.length > 0 && name.trim() === name && !INVALID_NAME.test(name) && !name.endsWith('.')
}
function filename(page: Page): string {
  const title = [...page.title.normalize('NFC').replace(/[\p{C}<>:"/\\|?*]/gu, '-')]
    .slice(0, 40)
    .join('')
    .trim()
    .replace(/[. ]+$/u, '')
  return `${title || 'page'}--${page.pageId}.md`
}

/** Read the central directory before JSZip can silently overwrite duplicate names. */
function directory(bytes: Uint8Array): EntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset
      break
    }
  }
  requireValid(
    end >= 0 && view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0
  )
  const count = view.getUint16(end + 10, true)
  requireValid(count >= 2 && count <= MAX_PAGES + 1 && view.getUint16(end + 8, true) === count)
  const size = view.getUint32(end + 12, true)
  const start = view.getUint32(end + 16, true)
  requireValid(start + size === end)
  let offset = start
  const names = new Set<string>()
  const ranges: Array<[number, number]> = []
  const entries: EntryInfo[] = []
  let expanded = 0
  for (let index = 0; index < count; index++) {
    requireValid(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50)
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const crc = view.getUint32(offset + 16, true)
    const compressed = view.getUint32(offset + 20, true)
    const uncompressed = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const attributes = view.getUint32(offset + 38, true)
    const local = view.getUint32(offset + 42, true)
    requireValid((flags & ~0x080e) === 0 && (method === 0 || method === 8))
    requireValid(view.getUint16(offset + 34, true) === 0 && (attributes & 0x10) === 0)
    const kind = (attributes >>> 16) & 0xf000
    requireValid(kind === 0 || kind === 0x8000)
    requireValid(offset + 46 + nameLength + extraLength + commentLength <= end)
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength)
    requireValid((flags & 0x0800) !== 0 || rawName.every(byte => byte < 128))
    const name = decoder.decode(rawName)
    const folded = name.normalize('NFC').toLowerCase()
    requireValid(flatName(name) && !names.has(folded))
    names.add(folded)
    requireValid(name === 'manifest.json' || (name.endsWith('.md') && [...name].length <= 81))
    requireValid(uncompressed <= (name === 'manifest.json' ? MAX_BYTES : MAX_PAGE_BYTES))
    expanded += uncompressed
    requireValid(expanded <= MAX_BYTES)
    requireValid(local + 30 <= start && view.getUint32(local, true) === 0x04034b50)
    requireValid(
      view.getUint16(local + 6, true) === flags && view.getUint16(local + 8, true) === method
    )
    const localNameLength = view.getUint16(local + 26, true)
    const localExtraLength = view.getUint16(local + 28, true)
    const data = local + 30 + localNameLength + localExtraLength
    requireValid(data + compressed <= start && localNameLength === nameLength)
    requireValid(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) === name)
    if ((flags & 8) === 0) {
      requireValid(view.getUint32(local + 14, true) === crc)
      requireValid(
        view.getUint32(local + 18, true) === compressed &&
          view.getUint32(local + 22, true) === uncompressed
      )
    }
    ranges.push([local, data + compressed])
    entries.push({ name, crc, size: uncompressed })
    offset += 46 + nameLength + extraLength + commentLength
  }
  requireValid(offset === end && names.has('manifest.json'))
  ranges.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < ranges.length; index++)
    requireValid(ranges[index - 1][1] <= ranges[index][0])
  return entries
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function readEntry(
  entry: JSZip.JSZipObject,
  info: EntryInfo,
  remaining: { bytes: number }
): Promise<Uint8Array> {
  // JSZip 3.10 exposes internalStream at runtime but omits it from JSZipObject's types.
  const stream = (
    entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): Stream }
  ).internalStream('uint8array')
  return new Promise((resolve, reject) => {
    let stopped = false
    let size = 0
    let crc = 0xffffffff
    const chunks: Uint8Array[] = []
    const fail = () => {
      if (stopped) return
      stopped = true
      stream.pause()
      chunks.length = 0
      reject(invalid())
    }
    stream.on('data', value => {
      if (stopped) return
      if (
        !(value instanceof Uint8Array) ||
        size + value.length > info.size ||
        value.length > remaining.bytes
      )
        return fail()
      size += value.length
      remaining.bytes -= value.length
      for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      chunks.push(value)
    })
    stream.on('error', fail)
    stream.on('end', () => {
      if (stopped) return
      if (size !== info.size || (crc ^ 0xffffffff) >>> 0 !== info.crc) return fail()
      stopped = true
      const result = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      resolve(result)
    })
    stream.resume()
  })
}

export async function exportMarkdownZip(domainBlob: Blob): Promise<Blob> {
  try {
    requireValid(domainBlob.size <= MAX_BYTES)
    const bundle = validate(
      JSON.parse(decoder.decode(await domainBlob.arrayBuffer()).replace(/^\uFEFF/u, '')),
      false
    ) as Bundle
    const zip = new JSZip()
    const manifest: Manifest = { ...bundle, pages: [] }
    let size = 0
    for (const page of bundle.pages) {
      const { body, ...metadata } = page
      const entry = filename(page)
      const bytes = encoder.encode(body)
      size += bytes.length
      zip.file(entry, body, { createFolders: false, unixPermissions: 0o100644 })
      manifest.pages.push({ ...metadata, filename: entry })
    }
    const metadata = encoder.encode(JSON.stringify(manifest, null, 2))
    requireValid(size + metadata.length <= MAX_BYTES)
    zip.file('manifest.json', JSON.stringify(manifest, null, 2), {
      createFolders: false,
      unixPermissions: 0o100644,
    })
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX',
    })
    requireValid(bytes.length <= MAX_BYTES)
    return new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
  } catch {
    throw invalid()
  }
}

export async function importMarkdownZip(file: File): Promise<File> {
  try {
    requireValid(file.size <= MAX_BYTES)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const entries = directory(bytes)
    // CRC is checked by our bounded stream; JSZip's checkCRC32 eagerly inflates every file.
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false })
    requireValid(Object.keys(zip.files).length === entries.length)
    for (const info of entries) {
      const entry = zip.files[info.name]
      requireValid(
        entry && !entry.dir && entry.name === info.name && entry.unsafeOriginalName === info.name
      )
    }
    const remaining = { bytes: MAX_BYTES }
    const metadata = entries.find(entry => entry.name === 'manifest.json')!
    const manifest = validate(
      JSON.parse(
        decoder
          .decode(await readEntry(zip.files[metadata.name], metadata, remaining))
          .replace(/^\uFEFF/u, '')
      ),
      true
    ) as Manifest
    const expected = new Set(['manifest.json', ...manifest.pages.map(page => page.filename)])
    requireValid(
      entries.length === expected.size && entries.every(entry => expected.has(entry.name))
    )
    const pages: Page[] = []
    for (const page of manifest.pages) {
      const info = entries.find(entry => entry.name === page.filename)
      requireValid(info)
      const body = decoder.decode(await readEntry(zip.files[info.name], info, remaining))
      pages.push({
        pageId: page.pageId,
        baseRevision: page.baseRevision,
        name: page.name,
        title: page.title,
        body,
      })
    }
    const bundle = validate({ ...manifest, pages }, false)
    const output = encoder.encode(JSON.stringify(bundle))
    requireValid(output.length <= MAX_BYTES)
    return new File([output], 'wiki-markdown.json', { type: 'application/json' })
  } catch {
    throw invalid()
  }
}
