import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { readRemoteCapabilities } from '@/kcoder/remotes/client'
import type {
  RemoteCapabilityCatalog,
  RemoteCapabilityObservationState,
} from '../../../../shared/generated/contracts'

export function NativeRemoteCapabilityCatalog() {
  const { t } = useTranslation('remoteCapabilities')
  const [catalog, setCatalog] = useState<RemoteCapabilityCatalog>()
  const [failure, setFailure] = useState<'stale' | 'unavailable'>()
  const [pending, setPending] = useState(false)
  const owner = useRef({
    generation: 0,
    mounted: true,
    abort: undefined as AbortController | undefined,
  })
  const read = async (cursor?: string) => {
    const current = owner.current
    current.abort?.abort()
    const generation = ++current.generation
    const abort = new AbortController()
    current.abort = abort
    setPending(true)
    setFailure(undefined)
    if (!cursor) setCatalog(undefined)
    try {
      const next = await readRemoteCapabilities(cursor, abort.signal)
      if (!current.mounted || abort.signal.aborted || current.generation !== generation) return
      if (cursor && next.snapshotId !== catalog?.snapshotId)
        throw new Error('REMOTE_CATALOG_CURSOR_STALE')
      setCatalog(next)
    } catch (error) {
      if (!current.mounted || abort.signal.aborted || current.generation !== generation) return
      setCatalog(undefined)
      setFailure(
        error instanceof Error && error.message === 'REMOTE_CATALOG_CURSOR_STALE'
          ? 'stale'
          : 'unavailable'
      )
    } finally {
      if (current.mounted && current.generation === generation) setPending(false)
    }
  }
  useEffect(() => {
    const current = owner.current
    current.mounted = true
    const stop = listenAccountContextChanges(() => {
      current.generation++
      current.abort?.abort()
      setCatalog(undefined)
      setPending(false)
      setFailure('stale')
    })
    return () => {
      current.mounted = false
      current.generation++
      current.abort?.abort()
      stop()
    }
  }, [])
  const state = (value: RemoteCapabilityObservationState) =>
    t(value === 'unavailable' ? 'unavailableState' : value)
  return (
    <section
      className="space-y-3 border-t border-border pt-5"
      data-testid="native-remote-capabilities"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold">{t('title')}</h2>
          <p className="text-sm text-text-secondary">{t('description')}</p>
        </div>
        <Button
          variant="outline"
          type="button"
          disabled={pending}
          onClick={() => void read()}
          data-testid="remote-catalog-refresh"
        >
          {pending ? t('loading') : t('refresh')}
        </Button>
      </div>
      {failure && (
        <p role="status" className="text-sm text-text-secondary">
          {t(failure)}
        </p>
      )}
      {catalog && !catalog.entries.length && (
        <p role="status" className="text-sm text-text-secondary">
          {t('empty')}
        </p>
      )}
      {catalog?.entries.map(entry => (
        <article
          key={entry.id}
          className="studio-card-spacing min-w-0 space-y-2 rounded-lg border border-border"
          data-testid="remote-capability-entry"
          data-capability={entry.capability}
          data-state={entry.state}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all text-sm font-medium">
              {entry.targetId} · {entry.capability}
            </h3>
            <span className="text-sm text-text-secondary">{state(entry.state)}</span>
          </div>
          <p className="text-sm text-text-secondary">
            {t(`reasons.${entry.reasonCode}`, { defaultValue: t('notObserved') })}
          </p>
          <p className="text-xs text-text-muted">
            {t('identity')}: {state(entry.identityState)} · {t('business')}:{' '}
            {state(entry.businessState)}
          </p>
          <details className="text-sm text-text-secondary">
            <summary className="cursor-pointer">{t('details')}</summary>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <dt>{t('protocol')}</dt>
                <dd className="break-all">
                  {entry.transport} / {entry.protocol} / {entry.protocolVersion ?? t('notObserved')}
                </dd>
              </div>
              <div>
                <dt>{t('lastObserved')}</dt>
                <dd>{entry.observedAt ?? t('notObserved')}</dd>
              </div>
              <div>
                <dt>{t('owner')}</dt>
                <dd className="break-all">
                  {entry.nativeOwner
                    ? `${entry.nativeOwner.accountId} / ${entry.nativeOwner.targetId}`
                    : t('notObserved')}
                </dd>
              </div>
              <div>
                <dt>{t('location')}</dt>
                <dd>{t(entry.boundary.location, { defaultValue: t('notObserved') })}</dd>
              </div>
              {!!entry.schemas.length && (
                <div className="sm:col-span-2">
                  <dt>{t('schema')}</dt>
                  <dd className="break-all">
                    {entry.schemas.map(schema => schema.name).join(', ')}
                    <p>{t('schemaUnknown')}</p>
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-2">{t('requestPolicy')}</p>
          </details>
        </article>
      ))}
      {catalog?.nextCursor && (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void read(catalog.nextCursor ?? undefined)}
        >
          {t('next')}
        </Button>
      )}
      {failure === 'stale' && (
        <Button type="button" variant="outline" disabled={pending} onClick={() => void read()}>
          {t('restart')}
        </Button>
      )}
    </section>
  )
}
