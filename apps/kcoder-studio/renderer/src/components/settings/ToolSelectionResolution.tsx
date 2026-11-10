import type { ResolvedStudioTool } from '../../../../shared/generated/contracts'
import { useTranslation } from '@/hooks/useTranslation'

/** Displays target-computed policy only; switches continue editing their own saved scope. */
export function ToolSelectionResolution({
  tool,
  configured,
  loading = false,
  backendUnsupported = false,
}: {
  tool?: ResolvedStudioTool
  configured?: boolean
  loading?: boolean
  backendUnsupported?: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <p className="break-words text-sm text-text-muted" data-testid="tool-selection-resolution">
      {t(
        configured === undefined
          ? 'tool_selections.configured_unknown'
          : configured
            ? 'tool_selections.configured_on'
            : 'tool_selections.configured_off'
      )}
      {' · '}
      {loading || !tool
        ? t(
            loading
              ? 'tool_selections.preview_loading'
              : backendUnsupported
                ? 'tool_selections.preview_unsupported'
                : 'tool_selections.preview_unknown'
          )
        : tool.effective
          ? t('tool_selections.preview_available')
          : `${t('tool_selections.preview_restricted')} ${tool.restrictions
              .map(reason =>
                t(`tool_selections.restrictions.${reason.source}`, { skill: reason.skill ?? '' })
              )
              .join(' / ')}`}
    </p>
  )
}
