// QA plan: model-independent ZIP boundary tests use in-memory, synthetic files.
// Verify readable Unicode Markdown round trips; reject traversal, symlinks,
// duplicate central entries, undeclared files, malformed manifests and size bombs.
// Each case owns its ZIP bytes; global Blob/File replacements are restored afterward.
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { exportMarkdownZip, importMarkdownZip } from './wikiMarkdownBundle'

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
})
afterEach(() => vi.unstubAllGlobals())

const pageId = '00000000-0000-0000-0000-000000000001'
const domain = {
  format: 'kcoder-wiki-markdown',
  version: 1,
  libraryId: '00000000-0000-0000-0000-000000000002',
  pages: [
    {
      pageId,
      baseRevision: '00000000-0000-0000-0000-000000000003',
      name: `${pageId}.md`,
      title: '知识库 / 中文 😀 标题',
      body: '\uFEFF# 标题\n\n可编辑的 Markdown。\n\n```rust\nlet x = 1;\n```\n',
    },
  ],
}
const displayName = `知识库 - 中文 😀 标题--${pageId}.md`
function manifest() {
  const page = domain.pages[0]
  return {
    ...domain,
    pages: [
      {
        pageId: page.pageId,
        baseRevision: page.baseRevision,
        name: page.name,
        title: page.title,
        filename: displayName,
      },
    ],
  }
}
async function makeZip(
  options: {
    name?: string
    body?: string
    extra?: boolean
    symlink?: boolean
    metadata?: unknown
  } = {}
) {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(options.metadata ?? manifest()), {
    createFolders: false,
  })
  zip.file(options.name ?? displayName, options.body ?? domain.pages[0].body, {
    createFolders: false,
    unixPermissions: options.symlink ? 0o120777 : 0o100644,
  })
  if (options.extra) zip.file('unexpected.md', 'unlisted', { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}
function file(bytes: Uint8Array) {
  return new File([new Uint8Array(bytes)], 'wiki.zip', { type: 'application/zip' })
}
function eocd(bytes: Uint8Array) {
  return bytes.length - 22
}

// Append a repeated central entry without going through JSZip's overwriting map.
function duplicatedDirectory(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = eocd(bytes)
  const start = view.getUint32(end + 16, true)
  const length =
    46 +
    view.getUint16(start + 28, true) +
    view.getUint16(start + 30, true) +
    view.getUint16(start + 32, true)
  const result = new Uint8Array(bytes.length + length)
  result.set(bytes.subarray(0, end))
  result.set(bytes.subarray(start, start + length), end)
  result.set(bytes.subarray(end), end + length)
  const patched = new DataView(result.buffer)
  patched.setUint16(end + length + 8, view.getUint16(end + 8, true) + 1, true)
  patched.setUint16(end + length + 10, view.getUint16(end + 10, true) + 1, true)
  patched.setUint32(end + length + 12, view.getUint32(end + 12, true) + length, true)
  return result
}
function lieAboutUncompressedSize(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes)
  const view = new DataView(result.buffer)
  let offset = view.getUint32(eocd(result) + 16, true)
  while (view.getUint32(offset, true) === 0x02014b50) {
    const length = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(result.subarray(offset + 46, offset + 46 + length))
    if (name !== 'manifest.json') {
      view.setUint32(offset + 24, 8, true)
      view.setUint32(view.getUint32(offset + 42, true) + 22, 8, true)
      return result
    }
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  throw new Error('fixture entry missing')
}

describe('bounded Markdown ZIP conversion (no model involvement)', () => {
  test('exports real readable Markdown and a body-free manifest, then preserves edits', async () => {
    const blob = await exportMarkdownZip(
      new Blob([JSON.stringify(domain)], { type: 'application/json' })
    )
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    expect(Object.keys(zip.files).sort()).toEqual([displayName, 'manifest.json'].sort())
    // This test reads only its own tiny fixture; production uses bounded internalStream.
    expect(await zip.files[displayName].async('string')).toBe(domain.pages[0].body)
    const metadata = JSON.parse(await zip.files['manifest.json'].async('string'))
    expect(metadata.pages[0]).not.toHaveProperty('body')
    expect(metadata.pages[0].name).toBe(`${pageId}.md`)
    const output = await importMarkdownZip(new File([blob], 'wiki.zip'))
    expect(JSON.parse(await output.text())).toEqual(domain)
    zip.file(displayName, '# 用户编辑\n\n新的正文 😀', { createFolders: false })
    const edited = await importMarkdownZip(
      file(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    )
    expect(JSON.parse(await edited.text()).pages[0].body).toBe('# 用户编辑\n\n新的正文 😀')
  })
  test('limits long titles to forty Unicode characters before the UUID', async () => {
    const title = '😀'.repeat(100)
    const blob = await exportMarkdownZip(
      new Blob([JSON.stringify({ ...domain, pages: [{ ...domain.pages[0], title }] })])
    )
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    expect(zip.file(`${'😀'.repeat(40)}--${pageId}.md`)).not.toBeNull()
    expect(
      JSON.parse(await (await importMarkdownZip(new File([blob], 'wiki.zip'))).text()).pages[0]
        .title
    ).toBe(title)
  })
  test.each(['../note.md', `sub/../${displayName}`, `C:\\${displayName}`])(
    'rejects an unsafe original ZIP name: %s',
    async name => {
      await expect(importMarkdownZip(file(await makeZip({ name })))).rejects.toThrow(
        'knowledge:invalidMarkdownBundle'
      )
    }
  )
  test('rejects symlinks, undeclared files and duplicate central directory entries', async () => {
    for (const bytes of [
      await makeZip({ symlink: true }),
      await makeZip({ extra: true }),
      duplicatedDirectory(await makeZip()),
    ]) {
      await expect(importMarkdownZip(file(bytes))).rejects.toThrow(
        'knowledge:invalidMarkdownBundle'
      )
    }
  })
  test('rejects malformed manifests instead of silently dropping fields or body mappings', async () => {
    const invalid = [
      { ...manifest(), unexpected: true },
      { ...manifest(), version: 99 },
      { ...manifest(), pages: [{ ...manifest().pages[0], name: '../file.md' }] },
      { ...manifest(), pages: [manifest().pages[0], manifest().pages[0]] },
      { ...manifest(), pages: [{ ...manifest().pages[0], filename: `other--${pageId}.md` }] },
    ]
    for (const metadata of invalid)
      await expect(importMarkdownZip(file(await makeZip({ metadata })))).rejects.toThrow(
        'knowledge:invalidMarkdownBundle'
      )
  })
  test('rejects compressed-file, declared-page and actual-inflate limits', async () => {
    const oversized = new File([], 'large.zip')
    Object.defineProperty(oversized, 'size', { value: 16 * 1024 * 1024 + 1 })
    await expect(importMarkdownZip(oversized)).rejects.toThrow('knowledge:invalidMarkdownBundle')
    const compressedBomb = await makeZip({ body: 'x'.repeat(256 * 1024 + 1) })
    await expect(importMarkdownZip(file(compressedBomb))).rejects.toThrow(
      'knowledge:invalidMarkdownBundle'
    )
    await expect(importMarkdownZip(file(lieAboutUncompressedSize(compressedBomb)))).rejects.toThrow(
      'knowledge:invalidMarkdownBundle'
    )
  })
  test('rejects invalid UTF-8 instead of replacing bytes silently', async () => {
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify(manifest()))
    zip.file(displayName, new Uint8Array([0xff, 0xfe, 0xff]))
    await expect(
      importMarkdownZip(file(await zip.generateAsync({ type: 'uint8array' })))
    ).rejects.toThrow('knowledge:invalidMarkdownBundle')
  })
})
