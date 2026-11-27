import { createContext, useContext } from 'react'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import type { WidgetApi } from '@/kcoder/widgetApi'
import type { McpAppApi } from '@/kcoder/mcpAppApi'
import type { WidgetInputPreview } from '@/kcoder/widgetPreviewEvents'

export interface ConversationWidgetsValue {
  key: string
  hostPanelId: string
  threadId: string
  references: WidgetRef[]
  previews: WidgetInputPreview[]
  api: WidgetApi
  mcpApps?: McpAppApi
  claimProbe?: (widget: WidgetRef) => boolean
  invalidated: boolean
  listingStatus: 'unrequested' | 'loaded' | 'failed'
  reload: () => void
  isCurrent: () => boolean
  addReference: (widget: WidgetRef) => void
  sendPrompt: (text: string) => void
}
export const ConversationWidgetsContext = createContext<ConversationWidgetsValue | null>(null)
const InactiveWidgetsContext = createContext<ConversationWidgetsValue | null>(null)

export interface WidgetMessageIdentity {
  terminal: boolean
  active?: boolean
  ownsWidgets?: boolean
  turnId?: string | null
  attemptId?: string
  subtaskId?: string | number | null
}
export const WidgetMessageContext = createContext<WidgetMessageIdentity>({ terminal: false })

export function widgetBelongsToMessage(
  widget: Pick<WidgetRef, 'turnId' | 'attemptId'>,
  message: WidgetMessageIdentity
) {
  if (message.ownsWidgets === false) return false
  if (message.attemptId)
    return (
      widget.attemptId === message.attemptId &&
      (!message.turnId || widget.turnId === message.turnId)
    )
  if (
    message.subtaskId != null &&
    [widget.attemptId, widget.turnId].includes(String(message.subtaskId))
  )
    return !message.turnId || widget.turnId === message.turnId
  return Boolean(message.turnId && widget.turnId === message.turnId)
}

export function useWidgetMessageActivity(message: WidgetMessageIdentity, enabled = true) {
  const context = useContext(enabled ? ConversationWidgetsContext : InactiveWidgetsContext)
  return Boolean(
    context &&
    !context.invalidated &&
    [...context.references, ...context.previews].some(widget =>
      widgetBelongsToMessage(widget, message)
    )
  )
}
