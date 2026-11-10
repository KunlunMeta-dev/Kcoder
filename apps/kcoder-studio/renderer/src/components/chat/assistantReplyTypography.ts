import { conversationBlockGap, conversationLetterGap, type ConversationSpacing } from '../../../../shared/conversationReading'
import type { CSSProperties } from 'react'
import type { ConversationFontScale, ConversationLineSpacing } from '@/host/appPreferences'

const FONT_SCALE: Record<ConversationFontScale, number> = {
  small: 0.9,
  normal: 1,
  large: 1.15,
}

const BODY_LINE_HEIGHT: Record<ConversationLineSpacing, number> = {
  compact: 20,
  snug: 22,
  normal: 24,
  relaxed: 30,
  airy: 34,
}

const HEADING_LINE_DELTA: Record<ConversationLineSpacing, number> = {
  compact: -4,
  snug: -2,
  normal: 0,
  relaxed: 6,
  airy: 10,
}

export interface AssistantReplyTypography {
  body: CSSProperties
  heading1: CSSProperties
  heading2: CSSProperties
  heading3: CSSProperties
}

export function resolveAssistantReplyTypography(
  fontScale: ConversationFontScale,
  lineSpacing: ConversationLineSpacing,
  reading?: { blockSpacing: ConversationSpacing; letterSpacing: ConversationSpacing; fontFamily?: string },
): AssistantReplyTypography {
  const scale = FONT_SCALE[fontScale]
  const headingStyle = (fontSize: number, lineHeight: number, readingRole?: string): CSSProperties => ({
    fontSize: reading && readingRole ? `calc(var(${readingRole}) * ${scale})` : `${Math.round(fontSize * scale)}px`,
    lineHeight: `${Math.max(1, lineHeight + HEADING_LINE_DELTA[lineSpacing])}px`,
  })
  return {
    body: {
      fontSize: `calc(var(--text-chat, 14px) * ${scale})`,
      lineHeight: `${BODY_LINE_HEIGHT[lineSpacing]}px`,
      ...(reading ? { letterSpacing: `${conversationLetterGap[reading.letterSpacing]}px`, fontFamily: reading.fontFamily, "--conversation-block-gap": `${conversationBlockGap[reading.blockSpacing]}px` } as CSSProperties : {}),
    },
    heading1: headingStyle(18, reading ? 30 : 28, '--text-heading-md'),
    heading2: headingStyle(16, reading ? 28 : 24, '--text-heading-sm'),
    heading3: headingStyle(14, reading ? 24 : 20, '--text-lg'),
  }
}
