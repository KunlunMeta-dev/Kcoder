const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const TAGS = new Set(
  'svg g path rect circle ellipse line polyline polygon text tspan title desc'.split(' ')
)
const ATTRS = new Set(
  'viewbox x y x1 x2 y1 y2 width height d points rx ry r cx cy fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity fill-opacity stroke-opacity transform text-anchor dominant-baseline font-weight preserveaspectratio'.split(
    ' '
  )
)
const TEXT_TAGS = new Set(['text', 'tspan', 'title', 'desc'])

function entities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (original, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? original
    const code =
      entity[1].toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : original
  })
}

/** Build a graphics-only tree without parsing any resource-bearing HTML document. */
export function safeWidgetPreviewSvg(source: string): string | undefined {
  if (new TextEncoder().encode(source).byteLength > 16 * 1024) return undefined
  const start = source.search(/<svg\b/i)
  if (start < 0) return undefined
  const document = globalThis.document.implementation.createDocument(SVG_NAMESPACE, 'svg', null)
  const root = document.documentElement
  const stack: Element[] = [root]
  let begun = false
  let nodes = 1
  for (let offset = start; offset < source.length;) {
    if (source[offset] !== '<') {
      const end = source.indexOf('<', offset)
      if (TEXT_TAGS.has(stack.at(-1)!.localName))
        stack
          .at(-1)!
          .appendChild(
            document.createTextNode(entities(source.slice(offset, end < 0 ? undefined : end)))
          )
      offset = end < 0 ? source.length : end
      continue
    }
    let quote = ''
    let end = offset + 1
    for (; end < source.length; end++) {
      const character = source[end]
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") quote = character
      else if (character === '>') break
    }
    if (end === source.length) break
    const token = source.slice(offset, end + 1)
    offset = end + 1
    const match = token.match(/^<(\/?)([a-z][\w:-]*)([\s\S]*?)>$/i)
    if (!match) continue
    const tag = match[2].toLowerCase()
    if (!TAGS.has(tag)) continue
    if (match[1]) {
      if (tag === 'svg' && stack.length === 1) break
      const index = stack.findLastIndex(element => element.localName === tag)
      if (index > 0) stack.splice(index)
      continue
    }
    const element = !begun && tag === 'svg' ? root : document.createElementNS(SVG_NAMESPACE, tag)
    if (element !== root) {
      if (++nodes > 500) return undefined
      stack.at(-1)!.appendChild(element)
    }
    begun = true
    for (const attribute of match[3].matchAll(
      /([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/gi
    )) {
      const name = attribute[1].toLowerCase()
      const value = entities(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
      if (!ATTRS.has(name) || /url\s*\(|javascript:|data:|https?:|[<>]/i.test(value)) continue
      element.setAttribute(
        name === 'viewbox'
          ? 'viewBox'
          : name === 'preserveaspectratio'
            ? 'preserveAspectRatio'
            : name,
        value
      )
    }
    if (element !== root && !/\/\s*>$/.test(token)) stack.push(element)
  }
  return new XMLSerializer().serializeToString(root)
}
