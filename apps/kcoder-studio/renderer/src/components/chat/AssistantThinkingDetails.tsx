import { conversationFontStack, useConversationFontStatus } from '@/features/appearance/conversationFonts'
import { resolveAssistantReplyTypography } from './assistantReplyTypography'
import { useLayoutEffect, useRef, useState } from 'react'
import { Brain, ChevronDown, LoaderCircle } from 'lucide-react'
import { ThinkingElapsedTime } from './ThinkingElapsedTime'
import { useTranslation } from '@/hooks/useTranslation'
import { useConversationPreferences, useInitialConversationPreferences } from '@/features/appearance/useConversationPreferences'

export function AssistantThinkingDetails({
  content,
  running,
  windowed = false,
  startedAt,
  completedAt,
}: {
  content: string
  running: boolean
  windowed?: boolean
  startedAt?: number
  completedAt?: number
}) {
  const { t } = useTranslation('chat')
  const preferences = useInitialConversationPreferences()
  const reading = useConversationPreferences()
  const fontStatus = useConversationFontStatus(reading.conversationFontFamily !== 'system')
  const typography = resolveAssistantReplyTypography(reading.conversationFontScale, reading.conversationLineSpacing, {
    blockSpacing: reading.conversationBlockSpacing ?? 'normal',
    letterSpacing: reading.conversationLetterSpacing ?? 'normal',
    fontFamily: reading.conversationFontFamily === 'system' || fontStatus === 'error' ? 'var(--font-ui)' : conversationFontStack,
  })
  const defaultExpanded = windowed ? running : !preferences.thinkingCollapsedByDefault
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = userExpanded ?? defaultExpanded
  const wasRunning = useRef(running)
  useLayoutEffect(() => {
    if (windowed && wasRunning.current !== running) setUserExpanded(null)
    wasRunning.current = running
  }, [running, windowed])
  if (!content.trim()) return null
  return (
    <div className="mb-3 text-sm text-text-secondary" data-testid="assistant-thinking-details">
      <button
        type="button"
        data-testid="assistant-thinking-toggle"
        aria-expanded={expanded}
        aria-busy={running}
        onClick={() => setUserExpanded(value => !(value ?? defaultExpanded))}
        className="flex min-h-8 items-center gap-1 hover:text-text-primary"
      >
        <ChevronDown className={`h-4 w-4 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" data-testid="assistant-thinking-icon" />
        {t(running ? 'thinking.running' : 'thinking.completed')}
        <ThinkingElapsedTime startedAt={startedAt} completedAt={completedAt} running={running} />
        {running ? (
          <LoaderCircle
            data-testid="assistant-thinking-spinner"
            aria-hidden="true"
            className="h-3 w-3 shrink-0 animate-spin"
          />
        ) : null}
      </button>
      {expanded ? (
        <div style={typography.body} className="whitespace-pre-wrap break-words" data-testid="assistant-thinking-content">
          {content}
        </div>
      ) : null}
    </div>
  )
}
