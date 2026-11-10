export interface DiffFileSection {
  oldPath?: string
  path: string
  lines: string[]
}

const DIFF_HEADER_PATTERN = /^diff --git ("(?:\\.|[^"\\])*"|a\/.+?) ("(?:\\.|[^"\\])*"|b\/.+)$/

function gitPath(raw: string): string | null {
  if (!raw.startsWith('"')) return raw
  if (!raw.endsWith('"')) return null
  const text = raw.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let index = 0; index < text.length;) {
    if (text[index] !== '\\') {
      const character = String.fromCodePoint(text.codePointAt(index)!)
      bytes.push(...encoder.encode(character))
      index += character.length
      continue
    }
    index++
    const octal = text.slice(index).match(/^[0-7]{1,3}/)?.[0]
    if (octal) {
      const byte = Number.parseInt(octal, 8)
      if (byte > 255 || byte === 0) return null
      bytes.push(byte)
      index += octal.length
    } else {
      const byte = escapes[text[index++]]
      if (byte === undefined) return null
      bytes.push(byte)
    }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) } catch { return null }
}

function headerPaths(line: string): [string, string] | null {
  const match = line.match(DIFF_HEADER_PATTERN)
  if (!match) return null
  // Git does not quote ordinary spaces. Prefer an identical old/new suffix
  // before falling back to the header split; rename metadata refines it below.
  const raw = line.slice('diff --git '.length)
  if (raw.startsWith('a/')) {
    for (let offset = raw.indexOf(' b/'); offset >= 0; offset = raw.indexOf(' b/', offset + 1)) {
      if (raw.slice(2, offset) === raw.slice(offset + 3)) return [raw.slice(2, offset), raw.slice(offset + 3)]
    }
  }
  const oldPath = gitPath(match[1])
  const path = gitPath(match[2])
  return oldPath?.startsWith('a/') && path?.startsWith('b/') ? [oldPath.slice(2), path.slice(2)] : null
}

export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = []
  let current: DiffFileSection | null = null
  let metadata = false

  for (const line of diff.split('\n')) {
    const paths = headerPaths(line)
    if (paths) {
      current = {
        oldPath: paths[0],
        path: paths[1],
        lines: [line],
      }
      sections.push(current)
      metadata = true
      continue
    }
    current?.lines.push(line)
    if (!current || !metadata) continue
    if (line.startsWith('@@') || line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) metadata = false
    else if (line.startsWith('rename from ')) current.oldPath = gitPath(line.slice(12)) ?? current.oldPath
    else if (line.startsWith('rename to ')) current.path = gitPath(line.slice(10)) ?? current.path
  }
  const byPath = new Map<string, DiffFileSection>()
  for (const section of sections) {
    const previous = byPath.get(section.path)
    if (previous) previous.lines.push(...section.lines)
    else byPath.set(section.path, section)
  }
  return [...byPath.values()]
}
