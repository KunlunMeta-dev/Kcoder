import type { WorkbenchMessage } from '@/types/workbench'
export interface WorkflowReference {
  id: string
  title: string
  version?: number
  runId?: string
  needsInput?: boolean
  activity?: string
  revision?: number
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function output(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length > 262144) return null
    try {
      return output(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (!object(value)) return null
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter(item => object(item) && item.type === 'text')
      .map(item => String((item as Record<string, unknown>).text ?? ''))
      .join('\n')
    return text.length <= 262144 ? output(text) : null
  }
  return value
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const versionNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export function workflowReferences(messages: WorkbenchMessage[]): WorkflowReference[] {
  const refs = new Map<string, WorkflowReference>()
  const runs = new Map<string, WorkflowReference>()
  const put = (ref: WorkflowReference) => {
    const key = ref.id
    refs.delete(key)
    refs.set(key, ref)
    if (ref.runId) runs.set(ref.runId, ref)
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool' || block.status !== 'done') continue
      const result = output(block.toolOutput)
      if (!result) continue
      if (block.toolName === 'WorkflowDraft') {
        const items = Array.isArray(result.items) ? result.items : [result]
        for (const item of items)
          if (object(item) && identifier(item.id) && typeof item.title === 'string') {
            put({
              id: item.id,
              title: item.title.slice(0, 200),
              ...(versionNumber(item.savedVersion) &&
              (item.status === 'saved' || block.toolInput?.action === 'list')
                ? { version: item.savedVersion }
                : {}),
              ...(typeof item.revision === 'number' ? { revision: item.revision } : {}),
            })
          }
      } else if (
        block.toolName === 'Workflow' &&
        identifier(block.toolInput?.definition_id) &&
        versionNumber(block.toolInput?.version)
      ) {
        const id = block.toolInput.definition_id,
          version = block.toolInput.version
        if (result.status === 'needs_input') put({ id, version, title: id, needsInput: true })
        else if (identifier(result.run_id))
          put({ id, version, title: id, runId: result.run_id, activity: block.id })
      } else if (
        block.toolName === 'Workflow' &&
        identifier(block.toolInput?.resume) &&
        identifier(result.run_id)
      ) {
        const previous = runs.get(block.toolInput.resume)
        if (previous && previous.runId === result.run_id) put({ ...previous, activity: block.id })
      }
    }
  }
  return [...refs.values()].slice(-6)
}
export function workflowReferenceKey(ref: WorkflowReference) {
  return `${ref.id}:${ref.version ?? 'draft'}:${ref.runId ?? ''}:${ref.activity ?? ''}`
}
