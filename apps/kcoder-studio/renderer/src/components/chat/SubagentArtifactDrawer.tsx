import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'

interface SubagentArtifactDrawerProps {
  open: boolean
  title: string
  content: string
  truncated: boolean
  /** Non-null renders the failure state; an empty message falls back to the localized default. */
  loading?: boolean
  error?: string | null
  onClose: () => void
}

export function SubagentArtifactDrawer({
  open,
  title,
  content,
  truncated,
  loading = false,
  error = null,
  onClose,
}: SubagentArtifactDrawerProps) {
  const { t } = useTranslation('common')
  useEscapeKey(onClose, open)

  if (!open) return null

  return createPortal(
    <div
      data-testid="subagent-artifact-overlay"
      className="fixed inset-0 z-modal bg-black/30"
      onClick={onClose}
    >
      <aside
        data-testid="subagent-artifact-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subagent-artifact-title"
        className="fixed inset-y-0 right-0 flex w-[560px] max-w-full flex-col border-l border-border bg-background text-text-primary shadow-[0_18px_60px_rgba(0,0,0,0.22)]"
        onClick={event => event.stopPropagation()}
      >
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <h2
            id="subagent-artifact-title"
            className="min-w-0 flex-1 truncate text-base font-semibold"
          >
            {title || t('workbench.subagent_artifact_title')}
          </h2>
          <button
            type="button"
            data-testid="subagent-artifact-close"
            className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text-primary"
            aria-label={t('workbench.subagent_artifact_close')}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div
              data-testid="subagent-artifact-loading"
              className="flex min-h-28 items-center justify-center text-sm text-text-secondary"
            >
              {t('workbench.subagent_artifact_loading')}
            </div>
          ) : error !== null ? (
            <div
              data-testid="subagent-artifact-error"
              className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-sm leading-6 text-text-secondary"
            >
              {error || t('workbench.subagent_artifact_error')}
            </div>
          ) : (
            <>
              {truncated && (
                <div
                  data-testid="subagent-artifact-truncated"
                  className="mb-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-5 text-text-secondary"
                >
                  {t('workbench.subagent_artifact_truncated')}
                </div>
              )}
              <pre
                data-testid="subagent-artifact-content"
                className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-text-primary"
              >
                {content}
              </pre>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body
  )
}
