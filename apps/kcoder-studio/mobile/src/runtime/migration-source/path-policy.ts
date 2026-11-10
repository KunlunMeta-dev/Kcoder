/** Conservative browser preflight mirrors Native source_upload/manifest.rs; Native remains authoritative. */
const cacheComponents = new Set(['.git', 'node_modules', '.venv', '__pycache__'])
const privateComponents = new Set(['auth.json', 'auth.toml', 'credentials.json', 'credentials.toml', '.credentials.json',
  'oauth.json', 'oauth_tokens.json', 'token.json', 'tokens.json', 'refresh_token', 'refresh-token', '.netrc', '.npmrc',
  'cookies', 'cookies.sqlite', '.ssh', '.aws', 'id_rsa', 'id_ed25519'])
const encoder = new TextEncoder()
export type SourceUploadExclusionReason = 'private' | 'cache'
export function sourceUploadPathExclusion(path: string): SourceUploadExclusionReason | null {
  const parts = path.split('/')
  if (!path || encoder.encode(path).length > 4096 || parts.length > 16) throw new Error('source_upload_invalid_relative_path')
  for (const part of parts) {
    if (!part || encoder.encode(part).length > 255 || part === '.' || part === '..' || /[. ]$/.test(part)
      || /[\p{Cc}\\:<>"|?*]/u.test(part)) throw new Error('source_upload_invalid_relative_path')
    const lower = part.toLowerCase(), stem = lower.split('.')[0].replace(/ +$/, '')
    if (['con', 'prn', 'aux', 'nul', 'conin$', 'conout$', 'clock$'].includes(stem) || /^(?:com|lpt)[1-9¹²³]$/.test(stem)) throw new Error('source_upload_invalid_relative_path')
    if (cacheComponents.has(lower)) return 'cache'
    if (lower.startsWith('.env') || privateComponents.has(lower) || lower.endsWith('.pem') || lower.endsWith('.key')) return 'private'
  }
  return null
}

export function assertSourceUploadPaths(paths: readonly string[]) {
  const nodes = new Map<string, { spelling: string; file: boolean }>()
  for (const path of paths) {
    if (sourceUploadPathExclusion(path)) throw new Error('source_upload_excluded_file')
    const parts = path.split('/')
    let spelling = '', folded = ''
    parts.forEach((part, index) => {
      spelling += (index ? '/' : '') + part; folded += (index ? '/' : '') + part.toUpperCase().toLowerCase()
      const file = index === parts.length - 1, previous = nodes.get(folded)
      if (previous && (previous.spelling !== spelling || previous.file || file)) throw new Error('source_upload_invalid_relative_path')
      if (!previous) nodes.set(folded, { spelling, file })
    })
  }
}
