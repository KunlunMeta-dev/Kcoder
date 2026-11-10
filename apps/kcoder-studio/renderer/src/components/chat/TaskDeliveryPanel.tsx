import { createTaskDeliveryDrafts, type TaskDeliveryDraftSlot, type TaskDeliveryDraftState } from '@/features/task-comparison/taskDeliveryDrafts'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import {
  taskDeliveryApi,
  type TaskDeliveryApi,
  type TaskDeliveryOwner,
} from '@/kcoder/taskDelivery'
import type {
  TaskDeliveryRecipient,
} from '../../../../shared/generated/contracts'

export interface TaskDeliveryPanelProps {
  owner: TaskDeliveryOwner
  supported: boolean
  originalTaskAvailable: boolean
  comparisonId?: string
  onAddToDraft?: (text: string, recipient: TaskDeliveryRecipient) => void
  api?: TaskDeliveryApi
  draftSlot?: TaskDeliveryDraftSlot
  isActive?: () => boolean
}

function sameRecipient(left: TaskDeliveryRecipient, right: TaskDeliveryRecipient) {
  return (
    left.taskId === right.taskId &&
    left.threadId === right.threadId &&
    left.deviceId === right.deviceId
  )
}
function sameSource(left: NonNullable<TaskDeliveryDraftState['delivery']>, right: NonNullable<TaskDeliveryDraftState['delivery']>) {
  return left.comparisonId === right.comparisonId && sameRecipient(left.recipient, right.recipient)
    && ['repository', 'branch', 'headCommit', 'baseBranch', 'baseCommit', 'diffSha256', 'workingSha256'].every(
      key => left.source[key as keyof typeof left.source] === right.source[key as keyof typeof right.source])
}

/** Each task owns its draft and request identity; late replies cannot target another task. */
export function TaskDeliveryPanel(props: TaskDeliveryPanelProps) {
  return (
    <TaskDeliveryPanelOwned
      key={JSON.stringify([
        props.owner.scope,
        props.owner.taskId,
        props.owner.threadId,
        props.owner.deviceId,
        props.comparisonId,
        props.draftSlot?.key,
      ])}
      {...props}
    />
  )
}

function TaskDeliveryPanelOwned({
  owner,
  supported,
  originalTaskAvailable,
  comparisonId,
  onAddToDraft,
  api: providedApi,
  draftSlot,
  isActive,
}: TaskDeliveryPanelProps) {
  const { t } = useTranslation('taskDelivery')
  const [localDrafts] = useState(createTaskDeliveryDrafts)
  const slot = draftSlot ?? localDrafts.slot('local')
  const retained = useSyncExternalStore(slot.subscribe, slot.getSnapshot, slot.getSnapshot)
  useLayoutEffect(() => { slot.activate() }, [slot])
  const { delivery, base, title, body, requestUnknown, queued } = retained
  const busy = retained.pending !== null
  const identityAvailable = !slot.unavailable
  const [error, setError] = useState(false)
  const [validated, setValidated] = useState(() => !retained.delivery)
  const [verifiedRequestId, setVerifiedRequestId] = useState<string | null>(null)
  const statusUncertain = retained.uncertain || (Boolean(delivery) && !validated)
  const [page, setPage] = useState(0)
  const alive = useRef(true)
  const api = providedApi ?? taskDeliveryApi(owner)
  const callback = useRef(onAddToDraft)
  const available = useRef(originalTaskAvailable && supported && identityAvailable)
  const active = useRef(isActive)
  useLayoutEffect(() => {
    callback.current = onAddToDraft
    available.current = originalTaskAvailable && supported && identityAvailable
    active.current = isActive
  }, [onAddToDraft, originalTaskAvailable, supported, isActive, identityAvailable])
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  async function perform(action: (initial: TaskDeliveryDraftState, commit: (change: (state: TaskDeliveryDraftState) => TaskDeliveryDraftState) => boolean) => Promise<void>) {
    const initial = slot.getSnapshot()
    if (initial.pending || !available.current || active.current?.() === false) return
    const operation = createRandomUuid()
    slot.update(state => state === initial ? { ...state, pending: operation } : state)
    const version = slot.getSnapshot().version
    if (alive.current) setError(false)
    const commit = (change: (state: TaskDeliveryDraftState) => TaskDeliveryDraftState) => {
      const state = slot.getSnapshot()
      if (state.pending !== operation || state.inputsRevision !== initial.inputsRevision || state.version !== version) return false
      slot.update(change)
      return true
    }
    try { await action(initial, commit) }
    catch {
      slot.update(state => state.pending === operation ? { ...state, uncertain: true } : state)
      if (alive.current && active.current?.() !== false) setError(true)
    } finally {
      slot.update(state => state.pending === operation ? { ...state, pending: null } : state)
    }
  }
  const prepare = () => perform(async (initial, commit) => {
    const result = await api.prepare(initial.base, comparisonId)
    if (result.threadId !== owner.threadId) throw new Error('delivery owner mismatch')
    const same = initial.delivery?.deliveryId === result.deliveryId && sameRecipient(initial.delivery.recipient, result.recipient)
      && initial.delivery.source.headCommit === result.source.headCommit && initial.delivery.source.baseCommit === result.source.baseCommit
    if (commit(state => ({ ...state, delivery: result, uncertain: false,
      title: same ? state.title : result.draft.title, body: same ? state.body : result.draft.body,
      requestId: same ? state.requestId : (result.request?.requestId ?? null),
      requestUnknown: same ? state.requestUnknown || Boolean(result.request) : Boolean(result.request), queued: false }))) {
      if (alive.current) { setValidated(true); setPage(0) }
    }
  })
  const refresh = () => perform(async (initial, commit) => {
    if (!initial.delivery) return
    const result = await api.read(initial.delivery.deliveryId)
    if (result.threadId !== owner.threadId || result.deliveryId !== initial.delivery.deliveryId || !sameSource(result, initial.delivery))
      throw new Error('delivery owner mismatch')
    if (initial.requestId && result.request && result.request.requestId !== initial.requestId)
      throw new Error('delivery request identity changed')
    if (commit(state => ({ ...state, delivery: result, uncertain: false,
      requestId: result.request?.requestId ?? state.requestId,
      requestUnknown: Boolean(result.request) || state.requestUnknown }))) {
      if (alive.current) { setValidated(true); setVerifiedRequestId(result.request?.requestId ?? null) }
    }
  })
  const queueRequest = () => {
    const state = slot.getSnapshot()
    if (!available.current || active.current?.() === false || !state.delivery || state.requestUnknown || state.delivery.request || !callback.current
      || state.base !== state.delivery.source.baseBranch || statusUncertain) return
    const stableId = state.requestId ?? createRandomUuid()
    // Retain intent before dispatch. Unmounting never permits a new request ID.
    slot.update(current => ({ ...current, requestId: stableId, requestUnknown: true }))
    return perform(async (initial, commit) => {
      const source = initial.delivery!
      const result = await api.request(source.deliveryId, stableId, initial.title, initial.body)
      if (result.threadId !== owner.threadId || result.deliveryId !== source.deliveryId
        || result.request?.requestId !== stableId || !sameRecipient(result.recipient, source.recipient))
        throw new Error('delivery receipt mismatch')
      if (!commit(current => ({ ...current, delivery: result, requestUnknown: true }))) return
      if (!alive.current || !available.current || active.current?.() === false) return
      slot.update(current => ({ ...current, appendUnknown: true }))
      callback.current?.(result.request.prompt, result.recipient)
      slot.update(current => ({ ...current, queued: true, appendUnknown: false }))
    })
  }
  const restoreRequest = () => {
    const state = slot.getSnapshot(), result = state.delivery
    if (!alive.current || !available.current || active.current?.() === false || !callback.current
      || !validated || state.uncertain || state.pending || state.queued || !result?.request
      || state.requestId !== result.request.requestId || verifiedRequestId !== result.request.requestId
      || result.threadId !== owner.threadId || result.status.sourceChanged || result.source.dirty
      || state.base !== result.source.baseBranch) return
    slot.update(current => ({ ...current, appendUnknown: true }))
    try {
      callback.current(result.request.prompt, result.recipient)
      slot.update(current => ({ ...current, queued: true, appendUnknown: false }))
    } catch {
      slot.update(current => ({ ...current, uncertain: true }))
      if (alive.current) setError(true)
    }
  }
  const queueFailure = (checkId: string) => perform(async (initial) => {
    if (!initial.delivery || !callback.current) return
    const result = await api.failure(initial.delivery.deliveryId, checkId)
    if (!alive.current || !available.current || active.current?.() === false) return
    if (result.threadId !== owner.threadId || result.headCommit !== initial.delivery.source.headCommit
      || result.checkId !== checkId || !sameRecipient(result.recipient, initial.delivery.recipient))
      throw new Error('delivery evidence mismatch')
    callback.current?.(result.prompt, result.recipient)
  })
  const requestResolved =
    !statusUncertain &&
    Boolean(
      delivery?.request &&
      delivery.status.pullRequest?.matchesRequest &&
      delivery.status.pushState === 'pushed'
    )
  const checks = statusUncertain ? [] : (delivery?.status.checks ?? [])
  const lastPage = Math.max(0, Math.ceil(checks.length / 10) - 1)
  const currentPage = Math.min(page, lastPage)
  const disabled = busy || !supported || !originalTaskAvailable || !identityAvailable

  return (
    <section
      className="min-w-0 space-y-2 text-sm text-text-secondary"
      data-testid="task-delivery-panel"
      aria-label={t('title')}
    >
      <p>{t('title')}</p>
      {!supported ? (
        <p role="status">{t('unsupported')}</p>
      ) : !originalTaskAvailable || !identityAvailable ? (
        <p role="status">{t('originalUnavailable')}</p>
      ) : (
        <>
          <p className="text-xs text-text-muted">{t('scope')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-2">
              <span>{t('base')}</span>
              <input
                className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8"
                data-testid="task-delivery-base"
                aria-label={t('base')}
                value={base}
                disabled={busy || (requestUnknown && !requestResolved)}
                maxLength={200}
                onChange={event => {
                  const value = event.target.value
                  slot.update(state => ({ ...state, base: value, inputsRevision: state.inputsRevision + 1 }))
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={disabled || !base.trim() || (requestUnknown && !requestResolved)}
              data-testid="task-delivery-prepare"
              onClick={prepare}
            >
              {t('prepare')}
            </Button>
            {delivery && (
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={disabled}
                data-testid="task-delivery-refresh"
                onClick={refresh}
              >
                {t('refresh')}
              </Button>
            )}
          </div>
          {busy && <p role="status">{t('loading')}</p>}
          {error && <p role="alert">{t(requestUnknown ? 'requestUnknown' : 'failed')}</p>}
          {queued && <p role="status">{t('queued')}</p>}
          {delivery && (
            <>
              <p className="break-all">
                {t('recipient', {
                  taskId: delivery.recipient.taskId,
                  deviceId: delivery.recipient.deviceId,
                })}
              </p>
              <p className="break-all">
                {delivery.source.repository} · {delivery.source.branch} ·{' '}
                <code>{delivery.source.headCommit}</code>
              </p>
              {statusUncertain ? (
                <p role="status" data-testid="task-delivery-current-unknown">
                  {t('currentStatusUnknown')}
                </p>
              ) : (
                <p>
                  {t(`push.${delivery.status.pushState}`, { defaultValue: t('push.unknown') })} ·{' '}
                  {t(`ci.${delivery.status.ciState}`)}
                </p>
              )}
              {(delivery.status.sourceChanged || base !== delivery.source.baseBranch) && <p role="status">{t('sourceChanged')}</p>}
              {delivery.source.dirty && <p role="status">{t('dirty')}</p>}
              {delivery.status.limitation && !delivery.status.sourceChanged && (
                <p role="status">
                  {t(`limitations.${delivery.status.limitation}`, {
                    defaultValue: t('limitations.githubUnavailable'),
                  })}
                </p>
              )}
              {!statusUncertain && delivery.status.pullRequest ? (
                <p className="break-all">
                  <a
                    href={delivery.status.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-focus underline"
                  >
                    PR #{delivery.status.pullRequest.number}
                  </a>
                  {' · '}
                  {t(`pr.${delivery.status.pullRequest.state}`, { defaultValue: t('pr.UNKNOWN') })}
                  {' · '}
                  {t(`review.${delivery.status.pullRequest.reviewState}`, {
                    defaultValue: t('review.UNKNOWN'),
                  })}
                  {delivery.request && !delivery.status.pullRequest.matchesRequest && (
                    <span> · {t('requestNotMatched')}</span>
                  )}
                </p>
              ) : !statusUncertain ? (
                <p>{t('noPr')}</p>
              ) : null}
              <label className="block">
                {t('prTitle')}
                <input
                  className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8"
                  data-testid="task-delivery-title"
                  aria-label={t('prTitle')}
                  value={title}
                  maxLength={240}
                  disabled={busy || requestUnknown}
                  onChange={event => { const value = event.target.value; slot.update(state => ({ ...state, title: value, inputsRevision: state.inputsRevision + 1 })) }}
                />
              </label>
              <label className="block">
                {t('prBody')}
                <textarea
                  data-testid="task-delivery-body"
                  aria-label={t('prBody')}
                  className="min-h-32 w-full rounded-md border border-border bg-surface p-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  value={body}
                  maxLength={24576}
                  disabled={busy || requestUnknown}
                  onChange={event => { const value = event.target.value; slot.update(state => ({ ...state, body: value, inputsRevision: state.inputsRevision + 1 })) }}
                />
              </label>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={
                  disabled ||
                  statusUncertain ||
                  !onAddToDraft ||
                  requestUnknown ||
                  delivery.status.sourceChanged ||
                  delivery.source.dirty ||
                  base !== delivery.source.baseBranch ||
                  !title.trim()
                }
                data-testid="task-delivery-queue-publication"
                onClick={queueRequest}
              >
                {t('queuePublication')}
              </Button>
              {requestUnknown && <p role="status">{t('requestPrepared')}</p>}
              {retained.appendUnknown && !queued && <p role="status" data-testid="task-delivery-append-unknown">{t('recoverUncertain')}</p>}
              {delivery.request && !queued && <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8"
                data-testid="task-delivery-restore-request"
                disabled={disabled || statusUncertain || verifiedRequestId !== delivery.request.requestId || !onAddToDraft
                  || delivery.status.sourceChanged || delivery.source.dirty || base !== delivery.source.baseBranch}
                onClick={restoreRequest}>{t('recoverRequest')}</Button>}
              <details>
                <summary className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1">
                  {t('references')}
                </summary>
                <div className="space-y-1 break-all text-xs text-text-muted">
                  <p>
                    {t('deliveryIdentity')} <code>{delivery.deliveryId}</code>
                  </p>
                  {delivery.request && (
                    <p>
                      {t('requestIdentity')} <code>{delivery.request.requestId}</code>
                    </p>
                  )}
                  <p>
                    {t('sourceThread')} <code>{delivery.recipient.threadId}</code>
                  </p>
                  <p>
                    Diff SHA-256 <code>{delivery.source.diffSha256}</code>
                  </p>
                </div>
              </details>
              <ol className="min-w-0 space-y-2">
                {checks.slice(currentPage * 10, (currentPage + 1) * 10).map(check => (
                  <li key={check.checkId} className="min-w-0">
                    <span className="break-words">
                      {check.name} · {t(`ci.${check.state}`)}
                    </span>
                    {check.state === 'failed' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 md:min-h-8"
                        disabled={
                          disabled ||
                          statusUncertain ||
                          !onAddToDraft ||
                          delivery.status.sourceChanged
                        }
                        data-testid="task-delivery-queue-failure"
                        onClick={() => queueFailure(check.checkId)}
                      >
                        {t('queueFailure')}
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
              {delivery.status.checksTruncated && <p role="status">{t('checksTruncated')}</p>}
              {lastPage > 0 && (
                <nav className="flex items-center gap-2" aria-label={t('pages')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    {t('previous')}
                  </Button>
                  <span>
                    {currentPage + 1} / {lastPage + 1}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    disabled={currentPage === lastPage}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    {t('next')}
                  </Button>
                </nav>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
