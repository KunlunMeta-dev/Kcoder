import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationMcpCredentials } from '@/kcoder/useMigrationMcpCredentials'
import {
  mcpCandidatePrivateFields,
  mcpPrivateFieldKey as fieldKey,
} from '@/kcoder/migrationMcpFields'
import { MigrationMcpPrivateFieldPicker } from './MigrationMcpPrivateFieldPicker'
import type {
  MigrationJobReadResult,
  MigrationMcpCandidate,
} from '../../../../shared/generated/contracts'

export function MigrationMcpCredentialPanel(props: {
  deviceId: string
  workspacePath?: string
  job: MigrationJobReadResult
  itemId: string
  candidate?: MigrationMcpCandidate
  isCurrent: () => boolean
  onUpdated: (value: MigrationJobReadResult) => void
  onBusy: (busy: boolean) => void
  onClose: () => void
}) {
  const { t } = useTranslation('migration')
  const model = useMigrationMcpCredentials(props)
  const scopeKey = JSON.stringify([
    props.deviceId,
    props.workspacePath ?? '',
    props.job.job.jobId,
    props.itemId,
  ])
  const [selection, setSelection] = useState({ scopeKey, keys: new Set<string>() })
  const selected = selection.scopeKey === scopeKey ? selection.keys : new Set<string>()
  const [consentFor, setConsentFor] = useState<string | null>(null)
  const fields = useMemo(() => mcpCandidatePrivateFields(props.candidate), [props.candidate])
  const chosen = fields.filter(field => selected.has(fieldKey(field)))
  const { busy, plan } = model
  const { onBusy } = props
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  const consentKey = JSON.stringify([
    scopeKey,
    plan?.planId ?? null,
    plan?.phase ?? null,
    chosen.map(fieldKey),
  ])
  const consent = consentFor === consentKey
  const code = model.error || plan?.errorCode
  const form = model.current && (!plan || plan.phase === 'undone')
  return (
    <section
      data-testid="migration-mcp-credentials"
      className="mt-3 space-y-3 rounded-lg bg-surface p-3"
      aria-busy={busy}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{t('mcp_credential.title')}</h4>
        <Button size="sm" variant="ghost" disabled={busy} onClick={props.onClose}>
          {t('close')}
        </Button>
      </div>
      <p className="text-xs leading-5 text-text-secondary">{t('mcp_credential.boundary')}</p>
      {code && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${code}`, { defaultValue: t('error') })}
        </p>
      )}
      {form && (
        <>
          <MigrationMcpPrivateFieldPicker
            fields={fields}
            selected={chosen}
            consent={consent}
            disabled={busy}
            onFields={fields => {
              setSelection({ scopeKey, keys: new Set(fields.map(fieldKey)) })
              setConsentFor(null)
            }}
            onConsent={value => setConsentFor(value ? consentKey : null)}
          />
          <Button
            disabled={busy || !consent || !chosen.length}
            onClick={() => model.preview(chosen, consent)}
          >
            {t('mcp_credential.preview')}
          </Button>
        </>
      )}
      {plan && (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-text-secondary">{t('credential.destination')}</dt>
            <dd className="min-w-0 break-words">{plan.targetName}</dd>
            <dt className="text-text-secondary">{t('credential.storage')}</dt>
            <dd>{t(`credential.${plan.storage}`)}</dd>
            <dt className="text-text-secondary">{t('credential.source_field')}</dt>
            <dd className="min-w-0 break-words">
              {plan.fields
                .map(field => `${t(`mcp_credential.${field.kind}`)} · ${field.name}`)
                .join('、')}
            </dd>
          </dl>
          <p className="text-xs leading-5 text-text-secondary">
            {t(plan.storage === 'file' ? 'credential.file_notice' : 'credential.keyring_notice')}
          </p>
          <p role="status" className="text-sm">
            {t(`mcp_credential.phases.${plan.phase}`)}
          </p>
          {plan.phase !== 'undone' && plan.remainingFields > 0 && (
            <p className="text-sm text-text-secondary">
              {t('mcp_credential.remaining', { count: plan.remainingFields })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!['published', 'undone', 'conflict'].includes(plan.phase) && (
              <Button
                size="sm"
                disabled={busy}
                onClick={model.retryUndo ? model.undo : model.apply}
              >
                {t(
                  model.retryUndo
                    ? 'mcp_credential.resume_undo'
                    : plan.phase === 'ready'
                      ? 'mcp_credential.apply'
                      : 'mcp_credential.resume_apply'
                )}
              </Button>
            )}
            {!['undone', 'undoing'].includes(plan.phase) && (
              <Button size="sm" variant="outline" disabled={busy} onClick={model.undo}>
                {t(plan.phase === 'published' ? 'mcp_credential.undo' : 'mcp_credential.discard')}
              </Button>
            )}
          </div>
          {plan.phase === 'undone' && (
            <p className="text-xs text-text-secondary">{t('mcp_credential.reselect')}</p>
          )}
        </>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={model.refresh}>
        {t('refresh')}
      </Button>
      {busy && (
        <p role="status" className="text-xs text-text-secondary">
          {t('busy')}
        </p>
      )}
    </section>
  )
}
