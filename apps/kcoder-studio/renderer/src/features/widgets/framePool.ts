import { WIDGET_LIMITS } from './types'

type Entry = { panelId: string; granted: boolean; notify: (granted: boolean) => void }

/** Visible owners are queued fairly; each release promotes the oldest waiter. */
export class WidgetFramePool {
  private entries = new Map<string, Entry>()
  private globalLimit: number
  private panelLimit: number
  constructor(globalLimit = WIDGET_LIMITS.globalFrames, panelLimit = WIDGET_LIMITS.panelFrames) {
    this.globalLimit = globalLimit
    this.panelLimit = panelLimit
  }

  acquire(owner: string, panelId: string, notify: Entry['notify']): () => void {
    const previous = this.entries.get(owner)
    if (previous?.granted) previous.notify(false)
    this.entries.delete(owner)
    const ownedEntry = { panelId, notify, granted: false }
    this.entries.set(owner, ownedEntry)
    this.reconcile()
    return () => {
      const entry = this.entries.get(owner)
      if (entry !== ownedEntry) return
      if (entry?.granted) entry.notify(false)
      this.entries.delete(owner)
      this.reconcile()
    }
  }

  private reconcile() {
    const panels = new Map<string, number>()
    let total = 0
    for (const entry of this.entries.values()) {
      const panelCount = panels.get(entry.panelId) ?? 0
      const granted = total < this.globalLimit && panelCount < this.panelLimit
      if (granted) { total += 1; panels.set(entry.panelId, panelCount + 1) }
      if (entry.granted !== granted) { entry.granted = granted; entry.notify(granted) }
    }
  }

  get activeCount() { return [...this.entries.values()].filter(entry => entry.granted).length }
}

export const widgetFramePool = new WidgetFramePool()
