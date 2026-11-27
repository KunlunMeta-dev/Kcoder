import { useContext } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import {
  setStudioWorkMode,
  useStudioWorkMode,
  type StudioWorkMode,
} from '@/features/workbench/studioWorkMode'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeTaskAddress } from '@/types/api'
import styles from './StudioWorkModeSwitcher.module.css'

export function StudioWorkModeSwitcher({
  address,
  onNewChat,
}: {
  address?: RuntimeTaskAddress | null
  onNewChat: () => void
}) {
  const mode = useStudioWorkMode(address)
  const workbench = useContext(WorkbenchContext)
  const { t } = useTranslation('common')
  function select(next: StudioWorkMode) {
    if (next === mode) return
    if (workbench?.switchStudioWorkMode) workbench.switchStudioWorkMode(next)
    else {
      setStudioWorkMode(next)
      if (address) onNewChat()
    }
  }
  return (
    <div
      role="group"
      aria-label={t('workbench.work_mode.label')}
      data-testid="studio-work-mode-switcher"
      className="relative isolate mx-2 mb-2 grid min-w-0 grid-cols-2 gap-0.5 rounded-lg bg-muted/70 p-0.5"
    >
      <span
        aria-hidden="true"
        data-testid="studio-work-mode-highlight"
        data-mode={mode}
        className={cn(
          'pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc((100%_-_0.375rem)/2)] rounded-md bg-background shadow-sm',
          styles.highlight
        )}
      />
      {(['kcoder', 'kworker'] as const).map(value => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          title={t(`workbench.work_mode.${value}_description`)}
          onClick={() => select(value)}
          className={cn(
            'relative z-10 min-h-8 max-sm:min-h-11 min-w-0 rounded-md px-2 text-sm transition-colors ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            styles.button,
            mode === value
              ? 'font-medium text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          )}
        >
          {value === 'kcoder' ? 'KCoder' : 'KWorker'}
        </button>
      ))}
    </div>
  )
}
