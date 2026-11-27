import { useContext, useMemo, useSyncExternalStore } from 'react'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'

const noSubscribe = () => () => {}
type Inputs = ReadonlyArray<Pick<ReturnType<typeof toolPathPreviews.readInputs>[number],
  'id' | 'name' | 'displayText' | 'startedAt'>>
const emptyInputs: Inputs = []
const noInputs = () => emptyInputs
const MAX_GENERATING_TOOLS = 64

interface GeneratingToolProjection {
  blocks: ProcessingBlock[]
  projectedNarrative: boolean
}

function createProjection(scope: {
  target?: string
  task?: string
  messageId: string
  subtaskId: string
}) {
  const pending = new Map<string, ToolBlock>()
  let inputs = emptyInputs, dirty = true
  return {
    subscribe(listener: () => void) {
      // Reconcile changes between render and subscription, including reactivation.
      dirty = true
      return toolPathPreviews.subscribe(() => { dirty = true; listener() }, scope.target, scope.task)
    },
    readInputs(): Inputs {
      if (dirty) {
        dirty = false
        const next = toolPathPreviews.readInputs(scope.target, scope.task).slice(0, MAX_GENERATING_TOOLS)
        if (next.length !== inputs.length || next.some((input, index) => {
          const previous = inputs[index]
          return input !== previous && (input.id !== previous.id || input.name !== previous.name ||
            input.startedAt !== previous.startedAt ||
            JSON.stringify(input.displayText) !== JSON.stringify(previous.displayText))
        })) inputs = next
      }
      return inputs
    },
    merge(blocks: ProcessingBlock[], content: string, inputs: Inputs): GeneratingToolProjection {
      if (!inputs.length) {
        pending.clear()
        return { blocks, projectedNarrative: false }
      }
      const known = new Set(blocks.map(block => block.id))
      const visibleIds = new Set(inputs.map(input => input.id))
      for (const id of pending.keys()) {
        if (known.has(id) || !visibleIds.has(id)) pending.delete(id)
      }
      const transient: ToolBlock[] = []
      for (const input of inputs) {
        if (known.has(input.id)) continue
        let block = pending.get(input.id)
        if (!block) {
          block = {
            id: input.id,
            subtaskId: scope.subtaskId,
            type: 'tool',
            toolName: input.name,
            status: 'generating_arguments',
            createdAt: input.startedAt ?? Date.now(),
          }
          pending.set(input.id, block)
        }
        block.displayText = input.displayText
        transient.push(block)
      }
      if (!transient.length) return { blocks, projectedNarrative: false }
      const projectedNarrative = Boolean(content.trim())
      const narrative: ProcessingBlock[] = projectedNarrative
        ? [
            {
              id: `${scope.messageId}:generating-narrative:${transient[0].id}`,
              subtaskId: scope.subtaskId,
              type: 'text',
              content,
              status: 'done',
              createdAt: transient[0].createdAt,
            },
          ]
        : []
      const projected = [...blocks, ...narrative]
      for (const block of transient) {
        let index = projected.length
        // Keep earlier parallel calls ahead of a later call that materialized first.
        while (index > 0 && projected[index - 1].type === 'tool' &&
          projected[index - 1].createdAt > block.createdAt) index--
        projected.splice(index, 0, block)
      }
      return { blocks: projected, projectedNarrative }
    },
  }
}

/** Presentation only: incomplete tool arguments never become transcript blocks. */
export function useGeneratingToolBlocks(
  blocks: ProcessingBlock[],
  enabled: boolean,
  messageId: string,
  subtaskId: string,
  content: string
) {
  const { target, task } = useContext(ToolProgressScopeContext)
  const active = enabled && Boolean(target && task)
  const projection = useMemo(
    () => createProjection({ target, task, messageId, subtaskId }),
    [target, task, messageId, subtaskId]
  )
  const inputs = useSyncExternalStore(
    active ? projection.subscribe : noSubscribe,
    active ? projection.readInputs : noInputs,
    noInputs
  )
  return useMemo(() => active ? projection.merge(blocks, content, inputs) : { blocks, projectedNarrative: false },
    [blocks, content, active, projection, inputs])
}
