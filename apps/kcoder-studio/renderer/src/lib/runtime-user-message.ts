const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im

export interface PersistedKCoderAttachment {
  filename: string
  mimeType: string
  fileSize: number
  path: string
}

export interface PersistedKCoderUserMessage {
  content: string
  attachments: PersistedKCoderAttachment[]
  clientMessageId?: string
}

export interface RuntimeUserMessageParts {
  prefix: string
  request: string
}

export function splitRuntimeUserMessage(content: string): RuntimeUserMessageParts | null {
  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN)
  if (requestMarker?.index === undefined) return null

  return {
    prefix: content.slice(0, requestMarker.index),
    request: parsePersistedKCoderUserMessage(
      content.slice(requestMarker.index + requestMarker[0].length)
    ).content,
  }
}

export function visibleRuntimeUserMessage(content: string): string {
  const parts = splitRuntimeUserMessage(content)
  return parts?.request ?? parsePersistedKCoderUserMessage(content).content
}

export function parsePersistedKCoderUserMessage(content: string): PersistedKCoderUserMessage {
  const withoutClientMessageIdentity = removeCompleteTaggedBlocks(
    content,
    'kcoder_client_message_identity'
  )
  const clientMessageId = withoutClientMessageIdentity.blocks
    .map(block => parseClientMessageIdentity(block))
    .find((value): value is string => Boolean(value))
  const withoutApplicationContext = removeCompleteTaggedBlocks(
    withoutClientMessageIdentity.content,
    'application_context'
  )
  const withoutClientContext = removeCompleteTaggedBlocks(
    withoutApplicationContext.content,
    'kcoder_client_context'
  )
  const withoutAttachments = removeCompleteTaggedBlocks(
    withoutClientContext.content,
    'kcoder_attachments'
  )

  return {
    content: visiblePersistedRuntimeText(withoutAttachments.content),
    ...(clientMessageId ? { clientMessageId } : {}),
    attachments: withoutAttachments.blocks
      .flatMap(block => block.split('\n'))
      .map(line => parsePersistedKCoderAttachment(line.trim()))
      .filter((value): value is PersistedKCoderAttachment => value !== null),
  }
}

/** Compatibility for old servers and cached transcripts; never alter model input. */
function visiblePersistedRuntimeText(content: string): string {
  const text = content.trim()
  const wrapped = [
    'system-reminder',
    'skill_content',
    'relevant-memories',
    'project-instructions',
  ].some(tag => new RegExp(`^<${tag}(?:\\s[^>]*)?>[\\s\\S]*</${tag}>$`).test(text))
  if (wrapped || /^<(?:subagent|task|workflow)_notification\s[^>]*\/>(?:\n|$)/.test(text)) {
    return ''
  }
  const prefixes = [
    '[system] ',
    '[system][',
    '[hook:Setup] ',
    '[hook:SessionStart] ',
    '[hook:InstructionsLoaded] ',
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    'Earlier conversation summary:\n',
    'Project instructions (KCODER.md):\n',
    'Project instructions:\n',
    'Additional instructions after compaction:\n',
    'Additional instructions:\n',
    'Relevant memories:\n',
    'You are currently in plan mode:\n',
    'Available tools after compaction: ',
    'Orchestrate resume point after compaction:\n',
    'Orchestrate resume point:\n',
    '<!--kcoder:compact-boundary-->\n',
    'TodoList maintenance reminder: ',
  ]
  const activeSkills =
    text.startsWith('Active skills: ') &&
    text.endsWith('. You may continue to use them via the skill tool.')
  const retainedFile =
    text.startsWith('Recent file read retained after compaction (') && text.includes('):\n')
  return activeSkills ||
    retainedFile ||
    text === '[earlier conversation truncated for compaction retry]' ||
    prefixes.some(prefix => text.startsWith(prefix))
    ? ''
    : text
}

function parseClientMessageIdentity(block: string): string | null {
  try {
    const value: unknown = JSON.parse(block.trim())
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export function parsePersistedKCoderAttachmentBlocks(blocks: unknown): PersistedKCoderAttachment[] {
  if (!Array.isArray(blocks)) return []
  return blocks.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const block = value as Record<string, unknown>
    if (block.type !== 'attachment' || !block.attachment || typeof block.attachment !== 'object') {
      return []
    }
    const attachment = block.attachment as Record<string, unknown>
    const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : ''
    const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType.trim() : ''
    const path = typeof attachment.path === 'string' ? attachment.path.trim() : ''
    const fileSize =
      typeof attachment.fileSize === 'number' && attachment.fileSize >= 0 ? attachment.fileSize : 0
    return filename && mimeType && path ? [{ filename, mimeType, fileSize, path }] : []
  })
}

export function isPersistedKCoderAttachmentBlock(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && (value as Record<string, unknown>).type === 'attachment'
  )
}

interface RemovedTaggedBlocks {
  content: string
  blocks: string[]
}

/**
 * Remove only fully closed runtime wrappers; preserve original text for incomplete tags so user input is not deleted accidentally.
 */
function removeCompleteTaggedBlocks(content: string, tagName: string): RemovedTaggedBlocks {
  const tagPattern = new RegExp(`<\\s*(/?)\\s*${tagName}\\b[^>]*>`, 'gi')
  const ranges: Array<{ start: number; end: number; innerStart: number; innerEnd: number }> = []
  let depth = 0
  let outerStart = -1
  let innerStart = -1
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(content)) !== null) {
    const closing = match[1] === '/'
    if (!closing) {
      if (depth === 0) {
        outerStart = match.index
        innerStart = tagPattern.lastIndex
      }
      depth += 1
      continue
    }

    if (depth === 0) continue
    depth -= 1
    if (depth === 0) {
      ranges.push({
        start: outerStart,
        end: tagPattern.lastIndex,
        innerStart,
        innerEnd: match.index,
      })
      outerStart = -1
      innerStart = -1
    }
  }

  let cursor = 0
  let visible = ''
  const blocks: string[] = []
  for (const range of ranges) {
    visible += content.slice(cursor, range.start)
    blocks.push(content.slice(range.innerStart, range.innerEnd))
    cursor = range.end
  }
  visible += content.slice(cursor)
  return { content: visible, blocks }
}

function parsePersistedKCoderAttachment(line: string): PersistedKCoderAttachment | null {
  if (line.startsWith('{')) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      const filename = typeof value.filename === 'string' ? value.filename.trim() : ''
      const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim() : ''
      const path = typeof value.path === 'string' ? value.path.trim() : ''
      const fileSize =
        typeof value.fileSize === 'number' && value.fileSize >= 0 ? value.fileSize : 0
      if (!filename || !mimeType || !path) return null
      return { filename, mimeType, fileSize, path }
    } catch {
      return null
    }
  }

  const legacy = line.match(/^- (.+) \(([^()\n]+)\): (.+)$/)
  if (!legacy) return null
  const [, filename, mimeType, path] = legacy
  if (!filename.trim() || !mimeType.trim() || !path.trim()) return null
  return {
    filename: filename.trim(),
    mimeType: mimeType.trim(),
    fileSize: 0,
    path: path.trim(),
  }
}
