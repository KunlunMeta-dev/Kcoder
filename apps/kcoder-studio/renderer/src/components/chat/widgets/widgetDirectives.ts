export interface WidgetDirective {
  widgetId: string
  revision: number
}
export type WidgetMarkdownPart =
  | { kind: 'markdown'; content: string }
  | { kind: 'widget'; reference: WidgetDirective; duplicate: boolean }
const DIRECTIVE =
  /^\s*::kcoder-widget\{\s*widget_id="([A-Za-z0-9_-]{1,128})"\s+revision=([1-9]\d{0,14})\s*\}\s*$/

/** Directives inside code examples remain ordinary text. */
export function splitWidgetDirectives(content: string): WidgetMarkdownPart[] {
  const parts: WidgetMarkdownPart[] = []
  const seen = new Set<string>()
  let lines: string[] = []
  let fence: { marker: string; length: number } | undefined
  const flush = () => {
    if (lines.length) {
      parts.push({ kind: 'markdown', content: lines.join('\n') })
      lines = []
    }
  }
  for (const line of content.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined
      lines.push(line)
      continue
    }
    const match = fence ? null : line.match(DIRECTIVE)
    if (!match) {
      lines.push(line)
      continue
    }
    const revision = Number(match[2])
    if (!Number.isSafeInteger(revision)) {
      lines.push(line)
      continue
    }
    flush()
    const key = `${match[1]}:${revision}`
    parts.push({
      kind: 'widget',
      reference: { widgetId: match[1], revision },
      duplicate: seen.has(key),
    })
    seen.add(key)
  }
  flush()
  return parts
}
