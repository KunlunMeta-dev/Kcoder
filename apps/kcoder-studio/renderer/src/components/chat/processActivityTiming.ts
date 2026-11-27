import { isActiveToolCallStatus } from '@wegent/chat-core'
import type { ProcessingBlock } from '@/types/workbench'

/** Group wall time spans its first event through its last receipt, including parallel calls. */
export function processActivityTiming(
  blocks: readonly ProcessingBlock[],
  thinkingActive: boolean,
): { running: boolean; startedAt?: number; completedAt?: number } {
  const validTime = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value >= 0
  const running = blocks.some(block => isActiveToolCallStatus(block.status) &&
    (block.type !== 'thinking' || thinkingActive))
  const starts = blocks.map(block => block.createdAt)
  const startedAt = starts.length && starts.every(validTime) ? Math.min(...starts) : undefined
  const ends = blocks.map(block =>
    validTime(block.completedAt) && block.completedAt >= block.createdAt ? block.completedAt : undefined)
  const completedAt = !running && ends.length && ends.every(validTime) ? Math.max(...ends) : undefined
  return { running, startedAt, completedAt }
}
