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
  collapsedByDefault,
}: {
  content: string
  running: boolean
  windowed?: boolean
  startedAt?: number
  completedAt?: number
  collapsedByDefault?: boolean
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
  const initiallyCollapsed = collapsedByDefault ?? preferences.thinkingCollapsedByDefault
  const defaultExpanded = !initiallyCollapsed
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = userExpanded ?? defaultExpanded
  const wasRunning = useRef(running)
  useLayoutEffect(() => {
    if ((windowed && wasRunning.current !== running) ||
      (wasRunning.current && !running && initiallyCollapsed)) setUserExpanded(null)
    wasRunning.current = running
  }, [running, windowed, initiallyCollapsed])
  if (!content.trim()) return null
  return (
    <div className="text-sm text-text-secondary" data-testid="assistant-thinking-details">
      <button
        type="button"
        data-testid="assistant-thinking-toggle"
        aria-expanded={expanded}
        aria-busy={running}
        aria-label={t(running ? 'turn_process.analyzing' : 'thinking.completed')}
        title={t(running ? 'turn_process.analyzing' : 'thinking.completed')}
        onClick={() => setUserExpanded(value => !(value ?? defaultExpanded))}
        className="process-summary-line flex w-full min-w-0 items-center gap-1.5 hover:text-text-primary"
      >
        <Brain className="h-4 w-4 shrink-0" aria-hidden="true" data-testid="assistant-thinking-icon" />
        <span className="process-summary-text min-w-0 truncate">{t(running ? 'turn_process.analyzing' : 'thinking.completed')}</span>
        <ThinkingElapsedTime startedAt={startedAt} completedAt={completedAt} running={running} />
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <ChevronDown className={`h-3 w-3 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
        </span>
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
