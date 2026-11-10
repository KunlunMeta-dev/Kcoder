import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import '@/styles/page-loading.css'

export function PageLoadingState({ fullScreen = false }: { fullScreen?: boolean }) {
  const { t } = useTranslation('common')
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 10000)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div
      className={cn('kcoder-page-loading', fullScreen && 'kcoder-page-loading-screen')}
      data-testid="page-loading-state"
      data-studio-page-pending=""
    >
      <div className="kcoder-page-loading-status" role="status" aria-live="polite">
        <span className="kcoder-page-loading-spinner" aria-hidden="true" />
        <span>{t('common.loading')}</span>
      </div>
      {slow && (
        <>
          <p className="kcoder-page-loading-help">{t('common.loading_slow')}</p>
          <Button
            type="button"
            variant="outline"
            className="max-md:min-h-11"
            onClick={() => window.location.reload()}
          >
            {t('common.reload_page')}
          </Button>
        </>
      )}
    </div>
  )
}
