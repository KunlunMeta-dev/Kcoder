import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { RuntimeTargetConfirmDialog } from '@/components/settings/RuntimeTargetConfirmDialog'
import type { AutomationSubscription } from '../../../../shared/generated/contracts'
import type { KnowledgeIntegrationClient } from './client'
import { OperationError } from './shared'
import { useDomainAction } from './useDomainAction'

export function SubscriptionRemoval({
  client,
  subscription,
  refresh,
}: {
  client: KnowledgeIntegrationClient
  subscription: AutomationSubscription
  refresh: () => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [open, setOpen] = useState(false)
  const action = useDomainAction(refresh, client)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={action.blocked}
        data-testid="subscription-remove-open"
      >
        {t('removeSubscription')}
      </Button>
      {!open && <OperationError error={action.error} onInspect={() => void action.inspect()} />}
      {open && (
        <RuntimeTargetConfirmDialog
          title={t('removeSubscriptionTitle')}
          description={t('removeSubscriptionDescription', { title: subscription.draft.title })}
          cancelLabel={t('cancel')}
          closeLabel={t('cancel')}
          confirmLabel={t('removeSubscription')}
          testId="subscription-remove-dialog"
          destructive
          pending={action.pending}
          confirmDisabled={action.blocked}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            void action
              .run(() => client.removeSubscription(subscription))
              .then(removed => {
                if (removed) setOpen(false)
              })
          }}
        >
          <OperationError error={action.error} onInspect={() => void action.inspect()} />
        </RuntimeTargetConfirmDialog>
      )}
    </>
  )
}
