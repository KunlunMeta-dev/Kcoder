import type { WidgetRef } from '../../../shared/generated/contracts'
import { validateWidgetReference } from './widgetApi'

export interface CommittedWidgetEvent {
  deviceId: string
  taskId: string
  widget: WidgetRef
}
const listeners = new Set<(event: CommittedWidgetEvent) => void>()

/** Called only from accepted app-server metadata, never from tool-output text. */
export function publishCommittedWidget(event: CommittedWidgetEvent): void {
  const widget = validateWidgetReference(event.widget)
  for (const listener of listeners) listener({ ...event, widget })
}

export function subscribeCommittedWidgets(listener: (event: CommittedWidgetEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
