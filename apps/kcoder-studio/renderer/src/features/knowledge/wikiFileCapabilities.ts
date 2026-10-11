/** Target-owned descriptors; the fallback describes the existing Wiki v1 contract. */
import type { KnowledgeFileCapability } from '../../../../shared/generated/contracts'
export type WikiFileCapability = KnowledgeFileCapability

export const WIKI_BATCH_MAX_FILES = 10
export const WIKI_BATCH_MAX_BYTES = 128 * 1024 * 1024
const document = (
  format: string,
  extensions: string[],
  mimeTypes: string[],
  warnings: string[] = []
): WikiFileCapability => ({
  format,
  extensions,
  mimeTypes,
  maxFileBytes: 32 * 1024 * 1024,
  maxExtractedBytes: 8 * 1024 * 1024,
  requiresVision: false,
  warnings,
})
export const wikiFileCapabilities: WikiFileCapability[] = [
  document('text', ['txt'], ['text/plain']),
  document('markdown', ['md'], ['text/markdown']),
  document('html', ['html', 'htm'], ['text/html'], ['html_offline']),
  document('pdf', ['pdf'], ['application/pdf'], ['pdf_text_only']),
  document(
    'docx',
    ['docx'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['docx_body_only']
  ),
  document(
    'xlsx',
    ['xlsx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['xlsx_cached_values']
  ),
  document(
    'pptx',
    ['pptx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['pptx_text_only']
  ),
  {
    ...document(
      'image',
      ['png', 'jpg', 'jpeg', 'webp'],
      ['image/png', 'image/jpeg', 'image/webp'],
      ['vision_uncertain']
    ),
    maxFileBytes: 10 * 1024 * 1024,
    requiresVision: true,
  },
]
export function wikiFileCapability(name: string, capabilities = wikiFileCapabilities) {
  const extension = name.split('.').pop()?.toLowerCase()
  return capabilities.find(capability => capability.extensions.includes(extension ?? ''))
}
export function wikiFileAccept(capabilities = wikiFileCapabilities) {
  return capabilities
    .flatMap(capability => capability.extensions.map(extension => `.${extension}`))
    .join(',')
}
export function wikiFileIssue(
  file: Pick<File, 'name' | 'size'>,
  capabilities = wikiFileCapabilities
) {
  const capability = wikiFileCapability(file.name, capabilities)
  if (!capability) return 'errorFormat' as const
  if (capability.available === false) return 'pdfRuntimeUnavailable' as const
  if (file.size > capability.maxFileBytes)
    return capability.requiresVision ? ('imageLimit' as const) : ('textLimit' as const)
  return undefined
}
export function wikiBatchIssue(
  files: Pick<File, 'name' | 'size'>[],
  capabilities = wikiFileCapabilities
) {
  if (
    files.length > WIKI_BATCH_MAX_FILES ||
    files.reduce((total, file) => total + file.size, 0) > WIKI_BATCH_MAX_BYTES
  )
    return 'batchLimit' as const
  return files.map(file => wikiFileIssue(file, capabilities)).find(Boolean)
}
