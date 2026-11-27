import { useTranslation } from '@/hooks/useTranslation'

export function AssistantThinkingIndicator({ thinking = false }: { thinking?: boolean }) {
  const { t } = useTranslation('chat')

  return (
    <div
      className="inline-flex items-center text-sm leading-[inherit]"
      data-testid="thinking-indicator"
    >
      <span className="waiting-thinking-text">{t(thinking ? 'thinking.running' : 'thinking.waiting')}</span>
    </div>
  )
}
