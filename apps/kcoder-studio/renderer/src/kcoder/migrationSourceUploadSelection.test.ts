import { Blob as NodeBlob } from 'node:buffer'
import { expect, it, vi } from 'vitest'
import { browserSourceUploadFiles, inspectBrowserSourceUploadFiles, SOURCE_UPLOAD_MAX_SCAN_FILES } from './migrationSourceUploadSelection'
import { SOURCE_UPLOAD_MAX_BYTES, selectSourceUploadFiles } from './migrationSourceUploadFiles'

function file(name: string, relative: string, size = 10): File {
  return { name, webkitRelativePath: relative, size, get path() { throw new Error('Native File.path must never be read') } } as unknown as File
}
it('uses only explicitly provided Blob names and strips exactly one selected product-directory root', () => {
  const files = [file('settings.json', '.claude/settings.json'), file('SKILL.md', '.claude/skills/office/SKILL.md')]
  expect(browserSourceUploadFiles('directory', files).map(value => value.relativePath)).toEqual(['settings.json', 'skills/office/SKILL.md'])
  expect(browserSourceUploadFiles('files', files).map(value => value.relativePath)).toEqual(['settings.json', 'SKILL.md'])
  expect(browserSourceUploadFiles('directory', files)[0].blob).toBe(files[0])
})
it('rejects mixed roots, drive paths, traversal, control names and duplicate relative files before any Blob read', () => {
  for (const paths of [ ['one/config.toml', 'two/AGENTS.md'], ['C:/config.toml'], ['../config.toml'], ['.codex/../config.toml'], ['.codex/a\\b'], ['.codex/a\u0000b'], ['.codex/config.toml', '.codex/config.toml'] ]) {
    expect(() => browserSourceUploadFiles('directory', paths.map(path => file(path.split('/').at(-1)!, path)))).toThrow('source_upload_invalid_relative_path')
  }
})
it('checks file count and total budget without reading payloads or trusting a browser absolute path', () => {
  expect(() => browserSourceUploadFiles('files', [])).toThrow('source_upload_raw_file_count')
  expect(() => browserSourceUploadFiles('files', [file('config.toml', '', SOURCE_UPLOAD_MAX_BYTES + 1)])).toThrow('source_upload_payload_budget')
  expect(() => browserSourceUploadFiles('files', [file('/absolute/config.toml', '')])).toThrow('source_upload_invalid_relative_path')
})
it('filters private/dependency entries before reading sizes or bodies and budgets only retained files', async () => {
  const bodyAccess = vi.fn(() => { throw new Error('AUTH_CANARY_BODY_MUST_NOT_BE_READ') })
  const excluded = (path: string) => ({ name: path.split('/').at(-1), webkitRelativePath: `.codex/${path}`, get size() { return bodyAccess() }, get slice() { return bodyAccess() } }) as unknown as File
  const retained = new NodeBlob(['model="fixture"'])
  Object.defineProperties(retained, { name: { value: 'config.toml' }, webkitRelativePath: { value: '.codex/config.toml' } })
  const source = [retained as unknown as File, excluded('auth.json'), excluded('nested/.credentials.json'), excluded('.git/index'), ...Array.from({ length: 1100 }, (_, n) => excluded(`node_modules/package-${n}/index.js`))]
  const result = inspectBrowserSourceUploadFiles('directory', source)
  expect(result.files.map(file => file.relativePath)).toEqual(['config.toml'])
  expect(result.excluded).toEqual({ private: 2, cache: 1101 })
  await selectSourceUploadFiles('codex', result.files, new AbortController().signal, () => true)
  expect(bodyAccess).not.toHaveBeenCalled()
  expect(() => inspectBrowserSourceUploadFiles('files', [excluded('auth.json')])).toThrow('source_upload_excluded_file')
  expect(bodyAccess).not.toHaveBeenCalled()
})
it('bounds the raw directory scan before touching entries and reports an all-excluded directory without reading it', () => {
  const read = vi.fn(() => { throw new Error('entry must not be accessed') })
  const raw = { length: SOURCE_UPLOAD_MAX_SCAN_FILES + 1, get 0() { return read() } }
  expect(() => inspectBrowserSourceUploadFiles('directory', raw)).toThrow('source_upload_raw_file_count')
  expect(read).not.toHaveBeenCalled()
  const result = inspectBrowserSourceUploadFiles('directory', [file('AUTH.JSON', '.codex/AUTH.JSON')])
  expect(result.files).toEqual([]); expect(result.excluded.private).toBe(1)
})
