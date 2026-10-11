/** Comparison key only: never rewrite an RPC path or use this as filesystem authorization. */
export function workspacePathKey(path: string | null | undefined): string {
  let value = path ?? ''
  // Interpret Windows syntax from the target path, not the client's operating system.
  // Restrict namespace removal to DOS drives and UNC shares; device paths stay opaque.
  if (/^\\\\\?\\/.test(value)) {
    // Verbatim paths preserve trailing dots/spaces and do not interpret forward
    // slashes or dot traversal like Win32 paths. Such names are not aliases.
    if (
      value.includes('/') ||
      value
        .slice(4)
        .split('\\')
        .some(part => /[. ]$/.test(part))
    )
      return value
    if (/^\\\\\?\\[a-z]:\\/i.test(value)) value = value.slice(4)
    else if (/^\\\\\?\\UNC\\/i.test(value)) value = `\\\\${value.slice(8)}`
    else return value
  }
  if (/^[a-z]:[\\/]/i.test(value)) {
    value = value[0].toUpperCase() + value.slice(1).replace(/\\/g, '/')
    return value.replace(/\/+$/, '') + (/^[a-z]:\/*$/i.test(value) ? '/' : '')
  }
  if (/^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(value)) {
    return value.replace(/\\/g, '/').replace(/\/+$/, '')
  }
  // Preserve component case, dot segments and POSIX backslashes. Windows directories
  // can be case-sensitive, and lexical parent traversal can cross a symlink boundary.
  return value === '/' ? value : value.replace(/\/+$/, '')
}

export function sameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return workspacePathKey(left) === workspacePathKey(right)
}
