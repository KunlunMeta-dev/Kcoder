import { useContext, useMemo, useSyncExternalStore } from 'react'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'

const noSubscribe = () => () => {}
const inactiveSnapshot = () => 0
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
  return {
    merge(blocks: ProcessingBlock[], content: string): GeneratingToolProjection {
      const inputs = toolPathPreviews
        .readInputs(scope.target, scope.task)
        .slice(0, MAX_GENERATING_TOOLS)
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
            createdAt: Date.now(),
          }
          pending.set(input.id, block)
        }
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
      return { blocks: [...blocks, ...narrative, ...transient], projectedNarrative }
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
  const revision = useSyncExternalStore(
    active ? toolPathPreviews.subscribe : noSubscribe,
    active ? toolPathPreviews.snapshot : inactiveSnapshot,
    inactiveSnapshot
  )
  return useMemo(() => {
    // A revision invalidates this projection without copying arguments into it.
    void revision
    return active ? projection.merge(blocks, content) : { blocks, projectedNarrative: false }
  }, [blocks, content, active, projection, revision])
}
