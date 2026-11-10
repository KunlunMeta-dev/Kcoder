import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  RequestUserInputCard,
  RequestUserInputSummary,
} from '@/components/chat/RequestUserInputCard'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import {
  createTaskInteractionTransport,
  TaskInteractionClientError,
  taskInteractionKey,
} from '@/kcoder/taskInteractionTransport'
import { startSnapshotPolling } from '@/lib/snapshotPolling'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import type { RuntimeTaskAddress, RequestUserInputResponse } from '@/types/api'
import type {
  TaskInteractionItemV1,
  TaskInteractionSnapshotV1,
  TaskInteractionStateV1,
} from '../../../../../shared/generated/contracts'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import { TaskWorkspaceTable } from '../TaskWorkspaceTable'

export function TaskPendingInteractions({
  address,
  onOpenParent,
  embedded = false,
}: {
  address: RuntimeTaskAddress
  onOpenParent?: (address: RuntimeTaskAddress) => void
  embedded?: boolean
}) {
  // Equivalent path spellings share the UI lifetime; the transport below keeps
  // the original RPC address, drafts and uncertain answer receipts intact.
  const scope = usePluginTargetScope(address.deviceId, workspacePathKey(address.workspacePath))
  return (
    <OwnedInteractions
      key={JSON.stringify([scope.key, address.taskId, address.threadId ?? null, address.runtimeHandle ?? null])}
      address={address}
      current={scope.isCurrent}
      onOpenParent={onOpenParent}
      embedded={embedded}
    />
  )
}
function OwnedInteractions({
  address,
  current,
  onOpenParent,
  embedded,
}: {
  address: RuntimeTaskAddress
  current: () => boolean
  onOpenParent?: (address: RuntimeTaskAddress) => void
  embedded: boolean
}) {
  const [ownedAddress] = useState(() => structuredClone(address))
  const { t } = useTranslation('taskInteractions')
  const [snapshot, setSnapshot] = useState<TaskInteractionSnapshotV1>(),
    [failure, setFailure] = useState<TaskInteractionClientError>(),
    [refresh, setRefresh] = useState(0)
  const [submissions, setSubmissions] = useState<
    Record<string, { state: TaskInteractionStateV1; response?: RequestUserInputResponse; settledSequence?: number }>
  >({})
  const settledSubmissionSequence = useRef(0)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const owner = useRef<ReturnType<typeof createTaskInteractionTransport> | null>(null),
    pending = useRef<AbortController | null>(null)
  const pageActive = useRetainedPageActive()
  useEffect(() => {
    const transport = createTaskInteractionTransport(ownedAddress, current)
    owner.current = transport
    return () => {
      transport.dispose()
      if (owner.current === transport) owner.current = null
    }
  }, [ownedAddress, current])
  useEffect(() => {
    // Refresh only owns snapshot reads. Answers keep the task-scoped transport
    // until the original task view closes or its account/target changes.
    const transport = owner.current
    if (!transport) return
    const stop = startSnapshotPolling({
      active: pageActive,
      isCurrent: current,
      poll: async (isLive, signal) => {
        const abort = new AbortController(),
          cancel = () => abort.abort()
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) abort.abort()
        pending.current = abort
        const settledBeforeRead = settledSubmissionSequence.current
        try {
          const value = await transport.read(abort.signal)
          if (!isLive()) return false
          setSnapshot(value)
          setFailure(undefined)
          // The runtime keeps sent/unknown answers fenced. A fresh actionable
          // pending item therefore confirms a rejected local submission. Reads
          // begun before its send settled cannot release that submission.
          const actionable = new Set(value.items.filter(item => item.state === 'pending')
            .map(item => taskInteractionKey(item.reference)))
          setSubmissions(old => {
            const retained = Object.entries(old).filter(([key, local]) =>
              !actionable.has(key) || local.state !== 'response_pending' ||
              local.settledSequence === undefined || local.settledSequence > settledBeforeRead)
            return retained.length === Object.keys(old).length ? old : Object.fromEntries(retained)
          })
          return value.items.some(
            item => item.state === 'pending' || item.state === 'response_pending'
          )
            ? 1000
            : 4000
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
      onError: error => {
        if (current()) {
          // Retain the original form and its unsent draft while reads recover.
          // The failure disables it until a fresh receipt has been verified.
          setFailure(
            error instanceof TaskInteractionClientError
              ? error
              : new TaskInteractionClientError('unavailable')
          )
        }
      },
    })
    return stop
  }, [pageActive, ownedAddress, current, refresh])
  const submit = (item: TaskInteractionItemV1, response: RequestUserInputResponse) => {
    const transport = owner.current,
      k = taskInteractionKey(item.reference)
    if (!transport || !current() || failure || item.state !== 'pending' || submissions[k]) return false
    setSubmissions(old => ({ ...old, [k]: { state: 'response_pending', response } }))
    return transport
      .respond(item.reference, response)
      .then(result => {
        const settledSequence = ++settledSubmissionSequence.current
        if (current()) setSubmissions(old => ({ ...old, [k]: { state: result.state, response, settledSequence } }))
      })
      .catch(error => {
        if (current()) {
          setSubmissions(old => ({ ...old, [k]: { state: 'unknown', response } }))
          setFailure(
            error instanceof TaskInteractionClientError
              ? error
              : new TaskInteractionClientError('outcome_unknown')
          )
        }
      })
      // The task-scoped pending/unknown state keeps input closed. Release only
      // this form's local guard so a verified rejection can restore its draft.
      .then(() => false)
  }
  const active = snapshot?.items.filter(item => item.state !== 'resolved') ?? []
  return (
    <section
      className={
        embedded
          ? 'min-w-0 space-y-3'
          : 'studio-card-spacing space-y-4 rounded-xl border border-border bg-background'
      }
      data-testid="task-pending-interactions"
    >
      <header className="flex flex-wrap items-center justify-end gap-3">
        {!embedded && <h2 className="min-w-0 flex-1 text-lg font-medium">{t('title')}</h2>}
        <Button
          variant="ghost"
          className="min-h-11 md:min-h-0"
          onClick={() => {
            pending.current?.abort()
            setDismissed(new Set())
            setRefresh(value => value + 1)
          }}
        >
          {t('refresh')}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11 md:min-h-0"
          onClick={() => {
            pending.current?.abort()
            setFailure(new TaskInteractionClientError('cancelled'))
          }}
        >
          {t('cancel')}
        </Button>
      </header>
      {!embedded && <p className="text-sm text-text-secondary">{t('description')}</p>}
      {snapshot?.originalViewRequired && (
        <p
          role="status"
          className="text-sm text-text-secondary"
          data-testid="task-interaction-original-required"
        >
          {t('originalRequired')}
        </p>
      )}
      {onOpenParent && (
        <Button
          variant="outline"
          className="min-h-11 md:min-h-0"
          data-testid="task-interaction-open-parent"
          onClick={() => {
            if (current()) onOpenParent(ownedAddress)
          }}
        >
          {t('openOriginal')}
        </Button>
      )}
      {failure && (
        <p role="status" className="text-sm text-text-secondary">
          {t(`errors.${failure.code}`)}
        </p>
      )}
      {!!snapshot?.items.length && snapshot.observationState === 'unknown' && (
        <p role="status" className="text-sm text-text-secondary">
          {t('unknown')}
        </p>
      )}
      {!!snapshot?.items.length &&
        snapshot.observationState === 'observed' &&
        active.length === 0 && (
          <p role="status" className="text-sm text-text-secondary">
            {t('empty')}
          </p>
        )}
      <TaskWorkspaceTable
        label={t('title')}
        columns={[t('columns.prompt'), t('columns.state')]}
        testId="task-pending-interactions-table"
        emptyMessage={
          !snapshot?.items.length
            ? t(snapshot?.observationState === 'observed' ? 'empty' : 'unknown')
            : undefined
        }
      >
        {snapshot?.items.map(item => {
          const k = taskInteractionKey(item.reference),
            local = submissions[k]
          const state =
            item.state === 'resolved'
              ? 'resolved'
              : item.state === 'unknown'
                ? 'unknown'
                : (local?.state ?? item.state)
          const payload: RequestUserInputPayload = {
            kind: 'request_user_input',
            requestId: item.reference.selector.requestId,
            itemId:
              item.reference.selector.approvalId ?? item.reference.selector.questionId ?? undefined,
            questions: item.presentation.questions.map(question => ({
              ...question,
              multiSelect: question.multiSelect === true,
            })),
            ...(item.presentation.approval
              ? {
                  approvalPresentation: {
                    kind: item.presentation.approval.kind,
                    subject: item.presentation.approval.subject ?? null,
                    input: item.presentation.approval.input ?? null,
                    reason: item.presentation.approval.reason ?? null,
                  },
                }
              : {}),
            ...(local?.response ? { response: local.response } : {}),
          }
          return (
            <tr key={k} data-testid="task-original-interaction" data-state={state}>
              <td className="min-w-64">
                {state === 'pending' || (state === 'response_pending' && local?.response) ? (
                  <div hidden={state !== 'pending' || dismissed.has(k)}>
                    <RequestUserInputCard
                      payload={payload}
                      // Native questions require every original answer; prompt text
                      // or item IDs cannot select the synthetic plan shortcut.
                      allowImplementationPlanShortcut={false}
                      autoSubmitOnOptionSelect={payload.questions?.length === 1}
                      disabled={Boolean(failure) || state !== 'pending'}
                      onSubmit={response => submit(item, response)}
                      onIgnore={() => setDismissed(old => new Set([...old, k]))}
                    />
                  </div>
                ) : null}
                {state !== 'pending' || dismissed.has(k) ? (
                  <RequestUserInputSummary payload={payload} />
                ) : null}
              </td>
              <td className="w-48 text-right">
                <p role="status" className="text-sm text-text-secondary">
                  {t(`states.${state}`)}
                </p>
              </td>
            </tr>
          )
        })}
      </TaskWorkspaceTable>
    </section>
  )
}
