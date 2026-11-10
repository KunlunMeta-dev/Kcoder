import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { ModelPolicyError, type ModelPolicyClient } from '@/kcoder/modelPolicies'
import type {
  IntegrationModelPolicyCatalog,
  IntegrationModelSelectionIntent,
  IntegrationModelResolutionResult,
  IntegrationModelHealthReport,
  IntegrationModelUsageReport,
} from '../../../../shared/generated/contracts'
const field =
  'min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary focus-visible:ring-2 focus-visible:ring-focus/60'
export type AutoPolicyIntent = Extract<IntegrationModelSelectionIntent, { kind: 'auto_policy' }>
export function PolicyPreview({
  client,
  catalog,
  value,
  onSelect,
}: {
  client: ModelPolicyClient
  catalog: IntegrationModelPolicyCatalog
  value?: IntegrationModelSelectionIntent
  onSelect?: (intent: AutoPolicyIntent) => void
}) {
  const { t } = useTranslation('modelPolicies')
  const options = catalog.policies.filter(policy => policy.enabled)
  const keyFor = (id: string, version: string) => JSON.stringify([id, version])
  const [choice, setChoice] = useState(
    value?.kind === 'auto_policy' &&
      options.some(
        policy => policy.reference.id === value.id && policy.reference.version === value.version
      )
      ? keyFor(value.id, value.version)
      : ''
  )
  const selected = options.find(
    policy => keyFor(policy.reference.id, policy.reference.version) === choice
  )
  const [preview, setPreview] = useState<{ key: string; value: IntegrationModelResolutionResult }>()
  const [health, setHealth] = useState<{ key: string; value: IntegrationModelHealthReport }>()
  const [usage, setUsage] = useState<{ key: string; value: IntegrationModelUsageReport }>()
  const [error, setError] = useState<'unavailable' | 'unsupported' | 'usage_unsupported'>()
  const [notice, setNotice] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const current = useRef(choice)
  useEffect(() => () => pending.current?.abort(), [])
  const read = async (kind: 'preview' | 'health' | 'usage') => {
    if (!selected || busy || !client.isCurrent()) return
    const abort = new AbortController()
    pending.current = abort
    const captured = choice
    setBusy(true)
    setError(undefined)
    try {
      if (kind === 'preview') {
        const result = await client.preview(
          selected.reference.id,
          selected.reference.version,
          abort.signal
        )
        if (!abort.signal.aborted && client.isCurrent() && current.current === captured)
          setPreview({ key: captured, value: result })
      } else if (kind === 'usage') {
        const result = await client.usage(
          selected.reference.id,
          selected.reference.version,
          abort.signal
        )
        if (!abort.signal.aborted && client.isCurrent() && current.current === captured)
          setUsage({ key: captured, value: result })
      } else {
        const result = await client.health(
          selected.reference.id,
          selected.reference.version,
          abort.signal
        )
        if (!abort.signal.aborted && client.isCurrent() && current.current === captured)
          setHealth({ key: captured, value: result })
      }
    } catch (error) {
      if (!abort.signal.aborted && client.isCurrent() && current.current === captured)
        setError(
          error instanceof ModelPolicyError && error.code === 'unsupported'
            ? kind === 'usage'
              ? 'usage_unsupported'
              : 'unsupported'
            : 'unavailable'
        )
    } finally {
      if (pending.current === abort) {
        pending.current = null
        setBusy(false)
      }
    }
  }
  const result = preview?.key === choice ? preview.value : undefined
  const observations = health?.key === choice ? health.value.observations : undefined
  const reportedUsage = usage?.key === choice ? usage.value.observations : undefined
  const tokens = (value: number | null | undefined) =>
    value == null ? t('unknownUsage') : value.toLocaleString()
  return (
    <section className="space-y-3" data-testid="model-policy-preview">
      <p className="text-sm text-text-secondary">{t('previewOnly')}</p>
      {value && value.kind !== 'auto_policy' && (
        <p className="text-sm text-text-secondary">{t('currentManual')}</p>
      )}
      {value?.kind === 'auto_policy' &&
        !options.some(
          policy => policy.reference.id === value.id && policy.reference.version === value.version
        ) && (
          <p role="status" className="text-sm text-text-secondary">
            {t('versionChanged')}
          </p>
        )}
      <label className="block space-y-1 text-sm">
        {t('choose')}
        <SettingsSelect
          className={field}
          value={choice}
          onChange={event => {
            pending.current?.abort()
            setBusy(false)
            current.current = event.target.value
            setChoice(event.target.value)
            setError(undefined)
            setNotice(false)
          }}
        >
          <option value="">{t('noSelection')}</option>
          {options.map(policy => (
            <option
              key={keyFor(policy.reference.id, policy.reference.version)}
              value={keyFor(policy.reference.id, policy.reference.version)}
            >
              {policy.title || policy.reference.id}
            </option>
          ))}
        </SettingsSelect>
      </label>
      {!options.length && <p className="text-sm text-text-secondary">{t('empty')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!selected || busy}
          onClick={() => void read('preview')}
        >
          {t('preview')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!selected || busy}
          onClick={() => void read('health')}
        >
          {t('readHealth')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!selected || busy}
          onClick={() => void read('usage')}
        >
          {t('readUsage')}
        </Button>
        {busy && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              pending.current?.abort()
              pending.current = null
              setBusy(false)
            }}
          >
            {t('cancel')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-text-secondary">
          {t(
            error === 'unsupported'
              ? 'healthUnavailable'
              : error === 'usage_unsupported'
                ? 'usageUnavailable'
                : 'unavailable'
          )}
        </p>
      )}
      {result && (
        <div className="space-y-2 rounded-lg bg-surface/70 p-3">
          <p className="text-sm font-medium">
            {t('previewModel')}: {result.model.providerId} / {result.model.modelId}
          </p>
          <p className="text-sm text-text-secondary">{t('budgetUnknown')}</p>
          <details>
            <summary className="cursor-pointer text-sm text-text-secondary">
              {t('configuration')}
            </summary>
            <code className="block break-all py-2 text-xs">{result.model.revision}</code>
          </details>
          {onSelect && value?.kind !== 'verifier_locked' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (
                  selected &&
                  result.policyRef?.id === selected.reference.id &&
                  result.policyRef.version === selected.reference.version
                ) {
                  onSelect({ kind: 'auto_policy', ...selected.reference })
                  setNotice(true)
                }
              }}
            >
              {t('usePolicy')}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-text-secondary">
          {t('selected')}
        </p>
      )}
      {observations && (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">{t('health')}</summary>
          {!observations.length && (
            <p className="py-2 text-sm text-text-secondary">{t('noHealth')}</p>
          )}
          <ul className="divide-y divide-border/60">
            {observations.map(item => (
              <li
                key={JSON.stringify([item.provider, item.model, item.configurationRevision])}
                className="space-y-1 py-3 text-sm"
              >
                <p className="break-words font-medium">
                  {item.provider} / {item.model}
                </p>
                <p>{t(item.state)}</p>
                {item.failure && (
                  <p className="text-text-secondary">
                    {t('reason')}: {t(`failure.${item.failure.category}`)}
                  </p>
                )}
                <p className="text-text-secondary">
                  {t('observed')}:{' '}
                  {item.lastObservedAt
                    ? new Date(item.lastObservedAt).toLocaleString()
                    : t('noObservation')}
                </p>
                {item.cooldownUntil && (
                  <p className="text-text-secondary">
                    {t('cooldown')}: {new Date(item.cooldownUntil).toLocaleString()}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {reportedUsage && (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">{t('usage')}</summary>
          <p className="py-2 text-sm text-text-secondary">{t('usageNote')}</p>
          <ul className="divide-y divide-border/60">
            {reportedUsage.map(item => (
              <li
                key={JSON.stringify([item.provider, item.model, item.configurationRevision])}
                className="space-y-1 py-3 text-sm"
              >
                <p className="break-words font-medium">
                  {item.provider} / {item.model}
                </p>
                <p className="text-text-secondary">
                  {t(item.complete ? 'usageComplete' : 'usagePartial')}
                </p>
                <p>
                  {t('inputTokens')}: {tokens(item.reportedInputTokens)} · {t('outputTokens')}:{' '}
                  {tokens(item.reportedOutputTokens)}
                </p>
                <p>
                  {t('totalTokens')}: {tokens(item.reportedTotalTokens)} · {t('cacheReadTokens')}:{' '}
                  {tokens(item.reportedCacheReadInputTokens)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
