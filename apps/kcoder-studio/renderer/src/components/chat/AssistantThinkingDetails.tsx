import { useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function AssistantThinkingDetails({
  content,
  running,
}: {
  content: string
  running: boolean
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  if (!content.trim()) return null
  return (
    <div className="mb-3 text-sm text-text-secondary" data-testid="assistant-thinking-details">
      <button
        type="button"
        data-testid="assistant-thinking-toggle"
        aria-expanded={expanded}
        aria-busy={running}
        onClick={() => setExpanded(value => !value)}
        className="flex min-h-8 items-center gap-1 hover:text-text-primary"
      >
        <ChevronDown className={`h-4 w-4 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
        {t(running ? 'thinking.running' : 'thinking.completed')}
        {running ? (
          <LoaderCircle
            data-testid="assistant-thinking-spinner"
            aria-hidden="true"
            className="h-3 w-3 shrink-0 animate-spin"
          />
        ) : null}
      </button>
      {expanded ? (
        <div className="whitespace-pre-wrap break-words" data-testid="assistant-thinking-content">
          {content}
        </div>
      ) : null}
    </div>
  )
}
