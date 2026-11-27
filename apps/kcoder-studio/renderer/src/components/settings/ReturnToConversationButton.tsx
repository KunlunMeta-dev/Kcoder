import { MessageSquareText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateToLastConversation } from '@/lib/navigation'

export function ReturnToConversationButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('common')
  const label = t('workbench.settings_return_to_conversation', '返回会话')

  return (
    <button
      type="button"
      data-testid="settings-return-to-conversation"
      onClick={navigateToLastConversation}
      aria-label={label}
      title={label}
      className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-sm text-text-secondary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <MessageSquareText className="h-4 w-4" aria-hidden="true" />
      {!compact && label}
    </button>
  )
}
