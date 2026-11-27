const STATIC_MARKDOWN_WINDOW_THRESHOLD = 4_000
const STATIC_MARKDOWN_CHUNK_TARGET = 1_200

export function splitStaticMarkdownChunks(
  content: string,
  threshold = STATIC_MARKDOWN_WINDOW_THRESHOLD
): string[] {
  if (content.length < threshold) return [content]

  const chunks: string[] = []
  let current = ''
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (const line of content.match(/.*(?:\n|$)/g) ?? []) {
    if (!fence && /^#{1,3}\s/.test(line) && current.length >= STATIC_MARKDOWN_CHUNK_TARGET) {
      chunks.push(current)
      current = ''
    }
    current += line
    const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\n\r]*)/)
    if (!match) continue
    const sequence = match[1]
    const suffix = match[2] ?? ''
    if (!sequence) continue
    const marker = sequence[0]
    if (marker !== '`' && marker !== '~') continue
    if (!fence) {
      if (marker === '`' && suffix.includes('`')) continue
      fence = { marker, length: sequence.length }
    } else if (fence.marker === marker && sequence.length >= fence.length && !suffix.trim()) {
      fence = null
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 1 ? chunks : [content]
}
