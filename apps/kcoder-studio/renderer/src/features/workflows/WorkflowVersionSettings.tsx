import type { ComponentProps, ReactNode } from 'react'
import { History } from 'lucide-react'
import { SettingsDialog } from '@/components/settings/settings-ui'
import { Button } from '@/components/ui/button'
import { DisclosureSection } from '@/components/ui/disclosure-section'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkflowVerification } from './WorkflowVerification'

export function WorkflowVersionSettings({
  children,
  onClose,
  ...verification
}: ComponentProps<typeof WorkflowVerification> & {
  children?: ReactNode
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <SettingsDialog
      title={t('workflowCanvas.advancedSettings')}
      testId="workflow-settings-dialog"
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      <div className="studio-card-stack pt-5">
        <WorkflowVerification {...verification} />
        <DisclosureSection
          title={t('workflowVerification.management')}
          icon={<History />}
          testId="workflow-management"
          tone="neutral"
        >
          {children}
        </DisclosureSection>
      </div>
      <div className="sticky bottom-0 z-10 mt-5 flex justify-end border-t border-border/50 bg-popover py-4">
        <Button
          type="button"
          variant="secondary"
          data-testid="workflow-settings-done"
          onClick={onClose}
        >
          {t('common.close')}
        </Button>
      </div>
    </SettingsDialog>
  )
}
