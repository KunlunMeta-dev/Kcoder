import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { animatePageSurface } from './pageTransitionAnimation'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateToParentPage } from '@/lib/navigation'
import { DesktopTopBar } from './DesktopTopBar'

/** Feature pages share one navigation row and retain their actual parent action. */
export function WorkspacePageHeader({
  title,
  actions,
  beforeBack,
  onBack = navigateToParentPage,
  backLabel,
  backTestId,
  testId = 'workspace-page-header',
}: {
  title: ReactNode
  actions?: ReactNode
  beforeBack?: ReactNode
  onBack?: () => void
  backLabel?: string
  backTestId?: string
  testId?: string
}) {
  const { t, i18n } = useTranslation('common')
  const header = useRef<HTMLElement>(null)
  useLayoutEffect(() => animatePageSurface(header.current?.parentElement), [])
  return (
    <DesktopTopBar
      elementRef={header}
      testId={testId}
      className="studio-page-header h-14 min-h-14 min-w-0 border-b border-border/50 px-5 max-md:px-3"
      leftClassName="min-w-0 shrink gap-3"
      rightClassName="min-w-0 gap-2"
      left={
        <>
          {beforeBack}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-text-secondary max-md:h-11 max-md:w-11"
            aria-label={
              backLabel ?? t('navigation.back', i18n.language.startsWith('zh') ? '返回' : 'Back')
            }
            data-testid={backTestId}
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          </Button>
          <span className="min-w-0 truncate text-base font-medium text-text-primary">{title}</span>
        </>
      }
      right={actions}
    />
  )
}
