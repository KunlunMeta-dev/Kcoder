import { useTranslation } from '@/hooks/useTranslation'
import type { MigrationMcpCredentialPlanSummary } from '../../../../shared/generated/contracts'

export function MigrationMcpCredentialSummary({
  plan,
}: {
  plan: MigrationMcpCredentialPlanSummary
}) {
  const { t } = useTranslation('migration')
  return (
    <div
      data-testid="migration-batch-mcp-credentials"
      className="mt-3 space-y-2 rounded-md bg-surface p-3 text-sm"
    >
      <h4 className="font-medium">
        {t('mcp_credential.title')} · {t(`mcp_credential.phases.${plan.phase}`)}
      </h4>
      <p className="text-xs leading-5 text-text-secondary">{t('batch_mcp.grouped')}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-text-secondary">{t('credential.destination')}</dt>
        <dd className="min-w-0 break-words">{plan.targetName}</dd>
        <dt className="text-text-secondary">{t('credential.storage')}</dt>
        <dd>{t(`credential.${plan.storage}`)}</dd>
        <dt className="text-text-secondary">{t('credential.source_field')}</dt>
        <dd className="min-w-0">
          <ul className="max-h-32 space-y-1 overflow-y-auto break-words">
            {plan.fields.map(field => (
              <li key={`${field.kind}:${field.name}`}>
                {t(`mcp_credential.${field.kind}`)} ·{' '}
                <span className="font-mono">{field.name}</span>
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <p className="text-xs leading-5 text-text-secondary">
        {t(plan.storage === 'file' ? 'credential.file_notice' : 'credential.keyring_notice')}
      </p>
      {plan.phase !== 'undone' && plan.remainingFields > 0 && (
        <p className="text-xs leading-5 text-text-secondary">
          {t('batch_mcp.remaining', { count: plan.remainingFields })}
        </p>
      )}
      {plan.errorCode && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${plan.errorCode}`, { defaultValue: t('error') })}
        </p>
      )}
    </div>
  )
}
