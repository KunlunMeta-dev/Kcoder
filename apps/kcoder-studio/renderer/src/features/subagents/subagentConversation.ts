import type { WorkbenchMessage, ToolBlock } from '@/types/workbench'

/** Presentation of the filtered public artifact, never private recovery data or authority.
 * Partial tails and older plain-text artifacts remain visible as an assistant message.
 * An unmatched tool start is unknown: observing text cannot establish liveness.
 */
export function subagentConversation(
  content: string,
  agentId: string,
  offset = 0
): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = []
  const tools = new Map<string, ToolBlock>()
  const markers = Array.from(
    content.matchAll(
      /^\[(user|assistant|tool\/start ([^\]\s]+)|tool\/result ([^\]\s]+))\](?: ([^\r\n]+))?\r?\n/gm
    )
  )
  const byteOffsets = new Map<number, number>([[0, offset]])
  let previousIndex = 0
  let byteIndex = offset
  for (const marker of markers) {
    byteIndex += new TextEncoder().encode(content.slice(previousIndex, marker.index!)).byteLength
    byteOffsets.set(marker.index!, byteIndex)
    previousIndex = marker.index!
  }
  const append = (role: 'user' | 'assistant', body: string, index: number) => {
    body = body.replace(/^<!-- kcoder-public-transcript:v2 -->\r?\n?/, '')
    if (!body.trim()) return
    messages.push({
      id: `${agentId}:${byteOffsets.get(index) ?? offset}`,
      role,
      content: body.trim(),
      status: 'done',
      createdAt: '',
    })
  }
  if (!markers.length) {
    append('assistant', content, 0)
    return messages
  }
  append('assistant', content.slice(0, markers[0].index), 0)
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]
    const body = content
      .slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? content.length)
      .trim()
    if (marker[1] === 'user' || marker[1] === 'assistant') {
      append(marker[1], body, marker.index!)
    } else if (marker[2]) {
      let input: Record<string, unknown> | undefined
      try {
        const value: unknown = JSON.parse(body)
        if (value && typeof value === 'object' && !Array.isArray(value))
          input = value as Record<string, unknown>
      } catch {
        /* Partial public pages retain the original text below. */
      }
      const block: ToolBlock = {
        id: marker[2],
        subtaskId: agentId,
        type: 'tool',
        toolName: marker[4] ?? marker[2],
        toolInput: input,
        status: 'unknown',
        rawStatus: 'result_unrecorded',
        createdAt: 0,
      }
      tools.set(marker[2], block)
      messages.push({
        id: `${agentId}:${byteOffsets.get(marker.index!)}`,
        role: 'assistant',
        content: input ? '' : body,
        blocks: [block],
        status: 'done',
        createdAt: '',
      })
    } else if (marker[3]) {
      const block = tools.get(marker[3])
      if (block) {
        block.status =
          marker[4] === 'completed' ? 'done' : marker[4] === 'error' ? 'error' : 'unknown'
        block.toolOutput = body
      } else append('assistant', body, marker.index!)
    }
  }
  return messages
}
