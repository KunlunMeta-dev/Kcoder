import { SOURCE_UPLOAD_MAX_BYTES, type SelectedSourceFile } from './migrationSourceUploadFiles'
import { assertSourceUploadPaths, sourceUploadPathExclusion } from './migrationSourceUploadPathPolicy'
const hasControl = (value: string) => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
export const SOURCE_UPLOAD_MAX_SCAN_FILES = 65536
export type BrowserSourceUploadSelection = { files: SelectedSourceFile[]; excluded: { private: number; cache: number } }

/** Strip only the directory the user just selected; never inspect File.path or infer a source home. */
export function inspectBrowserSourceUploadFiles(mode: 'files' | 'directory', files: ArrayLike<File>): BrowserSourceUploadSelection {
  if (!Number.isSafeInteger(files.length) || !files.length || files.length > SOURCE_UPLOAD_MAX_SCAN_FILES) throw new Error('source_upload_raw_file_count')
  const selected: SelectedSourceFile[] = [], excluded = { private: 0, cache: 0 }
  const root = mode === 'directory' ? files[0].webkitRelativePath?.split('/')[0] : null
  if (mode === 'directory' && (!root || root === '.' || root === '..' || /[:\\]/.test(root) || hasControl(root))) throw new Error('source_upload_invalid_relative_path')
  let bytes = 0
  for (let index = 0; index < files.length; index++) {
    const blob = files[index], original = mode === 'directory' ? blob.webkitRelativePath : blob.name
    if (mode === 'directory' && !original.startsWith(`${root}/`)) throw new Error('source_upload_invalid_relative_path')
    const relativePath = mode === 'directory' ? original.slice(root!.length + 1) : original
    const reason = sourceUploadPathExclusion(relativePath)
    if (reason) {
      if (mode !== 'directory') throw new Error('source_upload_excluded_file')
      excluded[reason]++; continue
    }
    if (selected.length >= 1024) throw new Error('source_upload_file_count')
    selected.push({ blob, relativePath }); bytes += blob.size
    if (!Number.isSafeInteger(bytes) || bytes > SOURCE_UPLOAD_MAX_BYTES) throw new Error('source_upload_payload_budget')
  }
  assertSourceUploadPaths(selected.map(file => file.relativePath))
  return { files: selected, excluded }
}

export const browserSourceUploadFiles = (mode: 'files' | 'directory', files: ArrayLike<File>) => inspectBrowserSourceUploadFiles(mode, files).files
