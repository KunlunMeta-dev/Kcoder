import { useEffect, useState, type ComponentType } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { MigrationContinuationSourceResult } from '../../../../../shared/generated/contracts'

export interface ImportedHistoryPanelProps {
  deviceId: string
  workspacePath?: string
  source: NonNullable<MigrationContinuationSourceResult['source']>
  isCurrent: () => boolean
}

/** Load historical display code only after the target has confirmed its provenance. */
export function ImportedHistoryPanel(props: ImportedHistoryPanelProps) {
  const { t } = useTranslation('migration')
  const [Content, setContent] = useState<ComponentType<ImportedHistoryPanelProps> | 'failed' | null>(null)
  useEffect(() => {
    let active = true
    import('./ImportedHistoryContent').then(module => {
      if (active) setContent(() => module.ImportedHistoryContent)
    }).catch(() => {
      if (active) setContent('failed')
    })
    return () => { active = false }
  }, [])
  if (Content && Content !== 'failed') return <Content {...props} />
  return <p data-testid="imported-history-module-status" role="status" aria-busy={Content !== 'failed'}
    className="mb-4 text-sm text-text-secondary">
    {t(Content === 'failed' ? 'conversation_history.load_failed' : 'conversation_history.loading')}
  </p>
}
