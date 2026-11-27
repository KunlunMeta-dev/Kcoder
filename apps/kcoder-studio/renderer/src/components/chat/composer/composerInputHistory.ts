import type { WorkbenchMessage } from '@/types/workbench'
import type { RuntimeTaskAddress } from '@/types/api'

const MAX_INPUT_HISTORY = 100

export function composerInputHistoryScope(address?: RuntimeTaskAddress | null, fallback?: string) {
  return JSON.stringify(
    address ? [address.deviceId, address.taskId, address.workspacePath] : fallback
  )
}

export function composerInputHistory(messages: readonly WorkbenchMessage[]): string[] {
  const entries: string[] = []
  for (let index = messages.length - 1; index >= 0 && entries.length < MAX_INPUT_HISTORY; index--) {
    const message = messages[index]
    if (message.role !== 'user' || !message.content.trim()) continue
    if (entries[entries.length - 1] !== message.content) entries.push(message.content)
  }
  return entries.reverse()
}

interface HistoryDraft {
  value: string
  selectionOffset: number
}

/** Navigation owns a fixed history snapshot so streaming cannot reorder a selection. */
export class ComposerInputHistory {
  private navigation: {
    entries: readonly string[]
    index: number
    draft: HistoryDraft
    recalledValue: string
  } | null = null

  reset() {
    this.navigation = null
  }

  isBrowsing(value: string) {
    return this.navigation?.recalledValue === value
  }

  observe(value: string) {
    if (this.navigation && !this.isBrowsing(value)) this.reset()
  }

  move(
    direction: 'up' | 'down',
    entries: readonly string[],
    draft: HistoryDraft,
    atBoundary: boolean
  ): HistoryDraft | null {
    this.observe(draft.value)
    if (!this.navigation) {
      if (direction !== 'up' || !atBoundary) return null
      const history = entries.filter(entry => entry.trim()).slice(-MAX_INPUT_HISTORY)
      if (!history.length) return null
      this.navigation = {
        entries: history,
        index: history.length,
        draft: { ...draft },
        recalledValue: draft.value,
      }
    }
    const navigation = this.navigation
    if (direction === 'down' && navigation.index + 1 >= navigation.entries.length) {
      const original = navigation.draft
      this.reset()
      return original
    }
    navigation.index = direction === 'up' ? Math.max(0, navigation.index - 1) : navigation.index + 1
    const value = navigation.entries[navigation.index]
    navigation.recalledValue = value
    return { value, selectionOffset: value.length }
  }
}
