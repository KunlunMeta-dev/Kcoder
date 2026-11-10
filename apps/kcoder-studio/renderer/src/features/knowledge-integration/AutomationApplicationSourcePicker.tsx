import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { createRandomUuid } from '@/lib/random-id'
import { useTranslation } from '@/hooks/useTranslation'
import type { IntegrationTaskCapabilitySourceDescriptor } from '../../../../shared/generated/contracts'
import {
  KnowledgeOperationError,
  type KnowledgeIntegrationClient,
  type SelectedAutomationApplicationSource,
} from './client'
import { fieldClass, OperationError } from './shared'

export function AutomationApplicationSourcePicker({
  client,
  value,
  disabled,
  onSelection,
}: {
  client: KnowledgeIntegrationClient
  value?: SelectedAutomationApplicationSource
  disabled?: boolean
  onSelection: (selection?: SelectedAutomationApplicationSource) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [revision, setRevision] = useState(0)
  const identity = useMemo(() => ({ id: createRandomUuid(), client, revision }), [client, revision])
  const [metadata, setMetadata] = useState<{
    id: string
    sources: IntegrationTaskCapabilitySourceDescriptor[]
    error?: KnowledgeOperationError
  }>()
  const [draft, setDraft] = useState<{
    id: string
    source?: IntegrationTaskCapabilitySourceDescriptor
    uri: string
    consent: boolean
  }>()
  const [action, setAction] = useState<{
    id: string
    pending: boolean
    error?: KnowledgeOperationError
  }>()
  const operation = useRef<{ id: string; cancel: AbortController } | undefined>(undefined)
  const current = draft?.id === identity.id ? draft : undefined
  const loaded = metadata?.id === identity.id ? metadata : undefined
  const ownedAction = action?.id === identity.id ? action : undefined
  const pending = ownedAction?.pending ?? false
  const original = client.pendingApplicationSelection()
  useEffect(() => {
    const cancel = new AbortController()
    void client.listApplicationSources(cancel.signal).then(
      sources => {
        if (!cancel.signal.aborted) setMetadata({ id: identity.id, sources })
      },
      error => {
        if (!cancel.signal.aborted)
          setMetadata({
            id: identity.id,
            sources: [],
            error:
              error instanceof KnowledgeOperationError
                ? error
                : new KnowledgeOperationError('AUTOMATION_APPLICATION_SOURCE_UNAVAILABLE'),
          })
      }
    )
    return () => {
      cancel.abort()
      if (operation.current?.id === identity.id) operation.current.cancel.abort()
    }
  }, [client, identity.id])
  const update = (change: Partial<NonNullable<typeof draft>>) => {
    onSelection(undefined)
    setDraft({
      id: identity.id,
      source: current?.source,
      uri: current?.uri ?? '',
      consent: false,
      ...change,
    })
  }
  const perform = async (reconcile = false) => {
    if (disabled || pending) return
    const cancel = new AbortController()
    operation.current = { id: identity.id, cancel }
    setAction({ id: identity.id, pending: true })
    try {
      let selection: SelectedAutomationApplicationSource | undefined
      if (reconcile && original)
        selection = (
          await client.reconcileApplicationEventSelection(original.operationId, cancel.signal)
        ).selection
      else {
        if (!current?.source || !current.consent || !current.uri.trim()) return
        selection = await client.selectApplicationEventSource(
          { sourceRef: current.source.sourceRef, accountRef: current.source.accountRef },
          current.uri.trim(),
          cancel.signal
        )
      }
      if (!cancel.signal.aborted && operation.current?.cancel === cancel) onSelection(selection)
    } catch (error) {
      if (!cancel.signal.aborted)
        setAction({
          id: identity.id,
          pending: false,
          error:
            error instanceof KnowledgeOperationError
              ? error
              : new KnowledgeOperationError(
                  'AUTOMATION_APPLICATION_SELECTION_UNCONFIRMED',
                  original?.operationId,
                  true
                ),
        })
    } finally {
      if (!cancel.signal.aborted && operation.current?.cancel === cancel)
        setAction(previous =>
          previous?.id === identity.id ? { ...previous, pending: false } : previous
        )
    }
  }
  return (
    <div className="studio-card-spacing space-y-3 rounded-xl border border-border" aria-busy={!loaded || pending}>
      <p className="text-sm text-text-secondary">{t('applicationResourceHint')}</p>
      <OperationError error={ownedAction?.error ?? loaded?.error} />
      {loaded && !loaded.error && !loaded.sources.length && (
        <p className="text-sm text-text-muted">{t('noApplicationResourceSources')}</p>
      )}
      <label className="block space-y-1 text-sm">
        <span>{t('applicationResourceSource')}</span>
        <SettingsSelect
          className={fieldClass}
          value={current?.source?.sourceRef.id ?? ''}
          disabled={disabled || pending || !!original || !loaded}
          data-testid="automation-application-source"
          onChange={event =>
            update({
              source: loaded?.sources.find(source => source.sourceRef.id === event.target.value),
            })
          }
        >
          <option value="">{t('chooseApplicationResourceSource')}</option>
          {loaded?.sources.map(source => (
            <option
              key={source.sourceRef.id}
              value={source.sourceRef.id}
              disabled={source.state !== 'ready'}
            >
              {source.displayName}
            </option>
          ))}
        </SettingsSelect>
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t('applicationResourceAddress')}</span>
        <input
          className={fieldClass}
          value={current?.uri ?? ''}
          disabled={disabled || pending || !!original}
          autoComplete="off"
          data-testid="automation-application-resource-uri"
          onChange={event => update({ uri: event.target.value })}
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={current?.consent ?? false}
          disabled={disabled || pending || !!original}
          onChange={event => update({ consent: event.target.checked })}
          data-testid="automation-application-read-consent"
        />
        <span>{t('applicationResourceReadConsent')}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={
            disabled ||
            pending ||
            !!original ||
            current?.source?.state !== 'ready' ||
            !current.uri.trim() ||
            !current.consent
          }
          data-testid="automation-application-authorize"
          onClick={() => void perform()}
        >
          {t('confirmApplicationResourceRead')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || pending || !!original}
          onClick={() => {
            onSelection(undefined)
            setRevision(value => value + 1)
          }}
        >
          {t('refresh')}
        </Button>
        {original && (
          <Button
            type="button"
            variant="outline"
            disabled={disabled || pending}
            data-testid="automation-application-reconcile"
            onClick={() => void perform(true)}
          >
            {t('reconcileOriginal')}
          </Button>
        )}
      </div>
      {value?.owner === client && (
        <p role="status" className="text-sm text-text-secondary">
          {t('applicationResourceReady')}
        </p>
      )}
    </div>
  )
}
