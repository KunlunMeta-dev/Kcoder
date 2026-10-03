function pathSeparators(path: string): string {
  const trimmed = path.trim()
  // Windows targets return drive or UNC paths; a POSIX backslash can be part
  // of a filename and must not be rewritten merely because it is present.
  return /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('\\\\')
    ? trimmed.replace(/\\/g, '/')
    : trimmed
}

function pathRoot(path: string): string {
  if (/^[a-z]:\//i.test(path)) return path.slice(0, 3)
  const unc = path.match(/^\/\/[^/]+\/[^/]+/)
  return unc?.[0] ?? '/'
}

export function normalizePath(path: string): string {
  const trimmed = pathSeparators(path)
  if (trimmed === pathRoot(trimmed)) return trimmed
  if (!trimmed || trimmed === '/') return trimmed || '/'
  return trimmed.replace(/\/+$/, '')
}

export function joinPath(parent: string, child: string): string {
  const normalizedParent = normalizePath(parent)
  if (!normalizedParent || normalizedParent === '/') return `/${child}`
  return `${normalizedParent}${normalizedParent.endsWith('/') ? '' : '/'}${child}`
}

export function basename(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean)
  return segments.at(-1) || 'project'
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path)
  const root = pathRoot(normalized)
  if (normalized === root) return root
  const separator = normalized.lastIndexOf('/')
  if (separator < root.length) return root
  return normalized.slice(0, separator)
}

export function getPathSearchParts(path: string): { parentPath: string; query: string } {
  const trimmedPath = pathSeparators(path)
  if (!trimmedPath || trimmedPath === '/') {
    return { parentPath: '/', query: '' }
  }

  if (trimmedPath.endsWith('/') || trimmedPath === pathRoot(trimmedPath)) {
    return { parentPath: normalizePath(trimmedPath), query: '' }
  }

  const normalized = normalizePath(trimmedPath)
  return {
    parentPath: getParentPath(normalized),
    query: basename(normalized),
  }
}

export function directoryMatchesQuery(directory: string, query: string): boolean {
  const normalizedDirectory = directory.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  if (normalizedDirectory.includes(normalizedQuery)) return true

  let queryIndex = 0
  for (const character of normalizedDirectory) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1
      if (queryIndex === normalizedQuery.length) return true
    }
  }
  return false
}
