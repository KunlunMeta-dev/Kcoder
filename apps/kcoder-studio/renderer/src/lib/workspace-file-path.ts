const WINDOWS_NAMESPACE_WINDOWS_PREFIX = '\\\\?\\'
const WINDOWS_NAMESPACE_POSIX_PREFIX = '//?/'

/**
 * True when the path uses a Windows namespace prefix in either the native
 * `\\?\` spelling or the forward-slashed `//?/` spelling produced when a
 * converter rewrote separators without stripping the prefix first.
 */
export function isWindowsNamespacePath(path: string): boolean {
  return (
    path.startsWith(WINDOWS_NAMESPACE_WINDOWS_PREFIX) ||
    path.startsWith(WINDOWS_NAMESPACE_POSIX_PREFIX)
  )
}

/**
 * Rewrites a namespaced path to plain path syntax with backslash separators so
 * later normalization can treat it as an ordinary absolute path.
 *
 * Returns null when the input is not namespaced, or when dropping the prefix
 * would change semantics: Win32 namespaces preserve trailing dots and spaces
 * and never interpret forward slashes or dot segments, so such names are not
 * equivalent to their plain spellings.
 */
export function stripWindowsNamespacePrefix(path: string): string | null {
  if (!isWindowsNamespacePath(path)) return null
  const posixSpelling = path.startsWith(WINDOWS_NAMESPACE_POSIX_PREFIX)
  const body = posixSpelling ? path.slice(4).replace(/\\/g, '/') : path.slice(4)
  // Native namespaces never treat forward slashes as separators; a slashed body
  // means an earlier conversion mangled the path, which is a call site bug.
  if (!posixSpelling && body.includes('/')) return null
  const parts = body.split(/[\\/]/)
  if (parts.some(part => /[. ]$/.test(part))) return null
  if (/^[a-z]:$/i.test(parts[0] ?? '')) return parts.join('\\')
  if (/^unc$/i.test(parts[0] ?? '')) return `\\\\${parts.slice(1).join('\\')}`
  return null
}

export function normalizeAbsoluteWorkspacePath(path: string, errorMessage: string): string {
  const namespaced = isWindowsNamespacePath(path)
  let value = namespaced ? path : path.trim()
  if (value.includes('\0')) throw new Error(errorMessage)
  if (namespaced) {
    const stripped = stripWindowsNamespacePrefix(value)
    if (stripped === null) throw new Error(errorMessage)
    value = stripped
  }
  let root: string
  let tail: string
  if (/^[a-z]:[\\/]/i.test(value)) {
    root = `${value[0].toUpperCase()}:/`
    tail = value.slice(3).replace(/\\/g, '/')
  } else if (value.startsWith('\\\\') || value.startsWith('//')) {
    const components = value.slice(2).replace(/\\/g, '/').split('/')
    const [server, share, ...rest] = components
    if (
      !server ||
      !share ||
      [server, share].some(part => part === '.' || part === '..' || /[?:]/.test(part))
    ) {
      throw new Error(errorMessage)
    }
    root = `//${server}/${share}`
    tail = rest.join('/')
  } else if (value.startsWith('/')) {
    root = '/'
    tail = value.slice(1)
  } else {
    throw new Error(errorMessage)
  }
  const parts: string[] = []
  for (const part of tail.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new Error(errorMessage)
      parts.pop()
    } else parts.push(part)
  }
  return root + (parts.length ? `${root.endsWith('/') ? '' : '/'}${parts.join('/')}` : '')
}

/**
 * Resolves a workspace file request against the workspace root.
 *
 * Absolute requests (POSIX, Windows drive, UNC, or namespaced spellings of any
 * of those) are normalized as-is; relative requests are joined under the
 * normalized root. Returns null when the request is empty, contains parent
 * traversal, is a mangled namespace that cannot be rewritten, or when the root
 * itself is not a usable absolute path.
 */
export function resolveWorkspaceFilePath(rootPath: string, path: string): string | null {
  const requested = path.trim()
  if (!requested) return null
  try {
    return normalizeAbsoluteWorkspacePath(requested, 'invalid workspace file path')
  } catch {
    // Fall through: the request may be a relative path under the root.
  }
  if (isWindowsNamespacePath(requested)) return null
  let root: string
  try {
    root = normalizeAbsoluteWorkspacePath(rootPath.trim(), 'invalid workspace root')
  } catch {
    return null
  }
  const segments: string[] = []
  for (const segment of requested.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null
  return `${root.replace(/\/+$/, '')}/${segments.join('/')}`
}

export function splitAbsoluteWorkspaceFilePath(filePath: string): {
  parentPath: string
  fileName: string
} {
  const path = normalizeAbsoluteWorkspacePath(filePath, 'Workspace file path must be absolute')
  if (path === '/' || /^[a-z]:\/$/i.test(path) || /^\/\/[^/]+\/[^/]+$/.test(path)) {
    throw new Error('Workspace file name is required')
  }
  const index = path.lastIndexOf('/')
  const parent = index === 0 ? '/' : path.slice(0, index)
  return {
    parentPath: /^[a-z]:$/i.test(parent) ? `${parent}/` : parent,
    fileName: path.slice(index + 1),
  }
}

/**
 * Relative path of `filePath` under `rootPath`, or '' when it is outside the root.
 *
 * Both sides are normalized first so namespaced (`\\?\C:`) and mixed-separator spellings
 * compare equal; Windows drive roots additionally fall back to a case-insensitive prefix
 * check because segment casing can differ between the workspace root and tree entries.
 */
export function relativeWorkspaceFilePath(rootPath: string, filePath: string): string {
  let normalizedRoot: string
  let normalizedTarget: string
  try {
    normalizedRoot = normalizeAbsoluteWorkspacePath(rootPath, 'invalid workspace root')
    normalizedTarget = normalizeAbsoluteWorkspacePath(filePath, 'invalid file path')
  } catch {
    return ''
  }
  if (normalizedTarget === normalizedRoot) return ''
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  if (normalizedTarget.startsWith(rootPrefix)) {
    return normalizedTarget.slice(rootPrefix.length)
  }
  const caseInsensitiveMatch =
    /^[a-z]:\//i.test(normalizedRoot) &&
    normalizedTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())
  if (caseInsensitiveMatch) {
    return normalizedTarget.slice(rootPrefix.length)
  }
  return ''
}
