import type { WorkbenchMessage } from '@/types/workbench'
import { type SelectedAssistantPlan } from './types'

export function findSelectedAssistantPlanContent(
  messages: WorkbenchMessage[],
  selectedPlan: SelectedAssistantPlan | null
): string | null {
  if (!selectedPlan) return null

  for (const message of messages) {
    const planBlock = message.blocks?.find(
      block =>
        block.type === 'plan' &&
        block.id === selectedPlan.blockId &&
        String(block.subtaskId) === selectedPlan.subtaskId
    )
    if (planBlock?.type === 'plan') return planBlock.content
  }

  return null
}

export function sanitizeEmbeddedBrowserLabelSegment(value: string) {
  return value
    .trim()
    .split('')
    .map(character => (/^[a-zA-Z0-9_-]$/.test(character) ? character : '-'))
    .join('')
}
