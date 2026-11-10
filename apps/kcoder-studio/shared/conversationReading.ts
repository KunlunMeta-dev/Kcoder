// Local reading preferences shared by clients; these values never enter target configuration.
export const conversationLineSpacings = ['compact', 'snug', 'normal', 'relaxed', 'airy'] as const
export const conversationSpacings = ['compact', 'normal', 'relaxed'] as const
export const conversationFontFamilies = ['noto-sans-sc', 'system'] as const
export type ConversationLineSpacing = typeof conversationLineSpacings[number]
export type ConversationSpacing = typeof conversationSpacings[number]
export type ConversationFontFamily = typeof conversationFontFamilies[number]

export function normalizeConversationLineSpacing(value: unknown): ConversationLineSpacing {
  return conversationLineSpacings.includes(value as ConversationLineSpacing)
    ? value as ConversationLineSpacing : 'normal'
}

export function normalizeConversationSpacing(value: unknown): ConversationSpacing {
  return conversationSpacings.includes(value as ConversationSpacing)
    ? value as ConversationSpacing : 'normal'
}

export function normalizeConversationFontFamily(value: unknown): ConversationFontFamily {
  return value === 'system' ? 'system' : 'noto-sans-sc'
}

export const conversationBlockGap: Record<ConversationSpacing, number> = { compact: 8, normal: 12, relaxed: 18 }
export const conversationLetterGap: Record<ConversationSpacing, number> = { compact: 0, normal: 0.2, relaxed: 0.6 }
