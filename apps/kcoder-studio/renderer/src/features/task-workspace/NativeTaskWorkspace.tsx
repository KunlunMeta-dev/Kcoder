import { TaskObservationOverview } from './TaskObservationOverview'
import { TaskWorkspaceTable } from './TaskWorkspaceTable'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState, useId } from 'react'
import { FileStack, Columns3, RefreshCw, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageContent } from '@/components/ui/page-content'
import { TaskBoard } from './TaskBoard'
import type { WorkControlApi } from './useWorkControl'
import { taskBoardChoiceKey, type TaskBoardObservation } from './taskBoardModel'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { subscribeLocalExecutorEvents } from '@/host/localExecutor'
import {
  isTaskStateObservation,
  sameTaskObservationScope,
} from '../../../../shared/taskStateObservations.mjs'
import {
  createTaskWorkspaceTransport,
  TaskWorkspaceClientError,
  type TaskWorkspaceReadError,
  type TaskWorkspaceTarget,
} from '@/kcoder/taskWorkspaceTransport'
import { TaskWorkspaceViewOwner, type TaskWorkspaceViewBinding } from './viewOwner'
import type {
  BackgroundRunKey,
  IntegrationTaskCapabilityScopeControlTarget,
  IntegrationEntityRef,
  TaskWorkspaceEntry,
  TaskWorkspaceNativeRef,
  TaskWorkspaceSnapshot,
} from '../../../../shared/generated/contracts'

export interface TaskWorkspaceThreadChoice {
  threadId: string
  title: string
  workspacePath?: string
  workId?: string
  board?: TaskBoardObservation
}
type AgentReference = Extract<TaskWorkspaceNativeRef, { kind: 'agent' }>
export type ExactTaskWorkspaceAgentRun = AgentReference & { backgroundRun: BackgroundRunKey }
export type TaskWorkspaceNavigableRef = Exclude<TaskWorkspaceNativeRef, { kind: 'agent' }>
export interface NativeTaskWorkspaceProps {
  target: TaskWorkspaceTarget
  tasks: TaskWorkspaceThreadChoice[]
  listingState?: 'ready' | 'loading' | 'unavailable'
  onNewTask?: () => void
  renderTaskActions?: (target: TaskWorkspaceTarget, threadId: string) => ReactNode
  renderPendingInteractions?: (target: TaskWorkspaceTarget, threadId: string) => ReactNode
  renderSourceRecords?: (
    target: TaskWorkspaceTarget,
    threadId: string,
    onSelectedTarget: (target: IntegrationTaskCapabilityScopeControlTarget | undefined) => void
  ) => ReactNode
  /** Legacy host callback retained for compatibility; the task board never invokes authoring. */
  onCreateCollaboration?: (target: TaskWorkspaceTarget, originalThreadId?: string) => void
  /** UI support only; the original view retains its normal native authorization. */
  canOpenReference?: (reference: TaskWorkspaceNavigableRef, target: TaskWorkspaceTarget) => boolean
  onOpenReference?: (reference: TaskWorkspaceNavigableRef, target: TaskWorkspaceTarget) => void
  /** Install only when the actual host supports the complete original run key. */
  onOpenAgentRun?: (reference: ExactTaskWorkspaceAgentRun, target: TaskWorkspaceTarget) => void
  onOpenArtifacts?: (
    references: IntegrationEntityRef[],
    target: TaskWorkspaceTarget,
    threadId: string
  ) => void
  /** Forwarded to the board; absent unless the target negotiated control. */
  control?: WorkControlApi
}
interface Observation {
  owner: string
  snapshot: TaskWorkspaceSnapshot
  page: number
  cursors: (string | undefined)[]
}
const choiceKey = taskBoardChoiceKey
const referenceKey = (reference: TaskWorkspaceNativeRef) => JSON.stringify(reference)

/** Read-only native projection; navigation delegates to existing original views. */
export function NativeTaskWorkspace({
  target,
  tasks,
  listingState = 'ready',
  onNewTask,
  canOpenReference,
  onOpenReference,
  onOpenAgentRun,
  onOpenArtifacts,
  renderTaskActions,
  renderPendingInteractions,
  renderSourceRecords,
  control,
}: NativeTaskWorkspaceProps) {
  const { t, i18n } = useTranslation('taskWorkspace')
  const selectId = useId()
  const detailsAnchor = useRef<HTMLDivElement | null>(null)
  const scrollRoot = useRef<HTMLDivElement | null>(null)
  const { key: scopeKey, isCurrent } = usePluginTargetScope(target.serverId, target.workspacePath)
  const base = JSON.stringify([target.serverId, target.workspacePath ?? null, scopeKey])
  const [selection, setSelection] = useState<{
    owner: string
    key: string
    threadId: string
    workspacePath?: string
    workId?: string
  }>()
  const choices = [
    ...new Map(
      tasks
        .filter(task => /^[A-Za-z0-9_-]{1,256}$/.test(task.threadId))
        .map(task => [choiceKey(task), task])
    ).values(),
  ]
  const selectionMatches =
    selection?.owner === base && !selection.workId
      ? choices.filter(
          task =>
            taskBoardChoiceKey({ threadId: task.threadId, workspacePath: task.workspacePath }) ===
            taskBoardChoiceKey({
              threadId: selection.threadId,
              workspacePath: selection.workspacePath,
            })
        )
      : []
  const selected =
    selection?.owner === base
      ? (choices.find(task => choiceKey(task) === selection.key) ??
        (selectionMatches.length === 1 ? selectionMatches[0] : undefined))
      : undefined
  const selectChoice = (task: TaskWorkspaceThreadChoice) =>
    setSelection({
      owner: base,
      key: choiceKey(task),
      threadId: task.threadId,
      workspacePath: task.workspacePath,
      workId: task.workId,
    })
  // A thread overview is not a per-Work result when several Works share it.
  const selectedThreadId = selected?.workId ? undefined : selected?.threadId
  const selectedWorkspacePath = selected?.workspacePath
  const threadIdentity = JSON.stringify([base, selected ? choiceKey(selected) : null])
  const [sourceChoice, setSourceChoice] = useState<{
    owner: string
    target: IntegrationTaskCapabilityScopeControlTarget
  }>()
  const sourceTarget = sourceChoice?.owner === threadIdentity ? sourceChoice.target : undefined
  const sourceKey = JSON.stringify(sourceTarget ?? null)
  const sourceOwner = useRef<{ identity: string; threadId?: string }>({
    identity: threadIdentity,
    threadId: selectedThreadId,
  })
  useEffect(() => {
    sourceOwner.current = { identity: threadIdentity, threadId: selectedThreadId }
  }, [threadIdentity, selectedThreadId])
  const [chooseSourceTarget] = useState(
    () => (target: IntegrationTaskCapabilityScopeControlTarget | undefined) => {
      const owner = sourceOwner.current
      if (target && target.initialAttempt.threadId !== owner.threadId) return
      setSourceChoice(
        target ? { owner: owner.identity, target: structuredClone(target) } : undefined
      )
    }
  )
  const identity = JSON.stringify([threadIdentity, sourceKey])
  const [refresh, setRefresh] = useState(0)
  const requestKey = JSON.stringify([identity, refresh])
  const [owner, setOwner] = useState(() => new TaskWorkspaceViewOwner(requestKey, isCurrent))
  // A new selected owner must be committed before any request effect starts.
  // The guarded state reset preserves StrictMode setup/cleanup and does no IO.
  if (owner.key !== requestKey) setOwner(new TaskWorkspaceViewOwner(requestKey, isCurrent))
  const [observation, setObservation] = useState<Observation>()
  const [error, setError] = useState<{ owner: string; code: TaskWorkspaceReadError }>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const serial = useRef(0)
  const pending = useRef<AbortController | undefined>(undefined)
  const visible = observation?.owner === identity && isCurrent() ? observation : undefined
  const reading = busy === requestKey
  const load = useCallback(
    async (
      cursor?: string,
      page = 0,
      snapshotId?: string,
      actualBinding?: TaskWorkspaceViewBinding
    ) => {
      const binding = actualBinding ?? owner.read()
      if (!binding || !owner.isCurrent(binding)) return
      const attempt = ++serial.current
      pending.current?.abort()
      const cancel = new AbortController()
      pending.current = cancel
      const current = () => attempt === serial.current && owner.isCurrent(binding)
      setBusy(requestKey)
      setError(undefined)
      setNotice(undefined)
      try {
        if (!Number.isInteger(page) || page < 0 || page >= 103)
          throw new TaskWorkspaceClientError('invalid_reply')
        let result: TaskWorkspaceSnapshot
        let reset = false
        try {
          result = await binding.transport.read(
            {
              threadId: binding.threadId,
              ...(sourceTarget ? { sourceTarget } : {}),
              ...(cursor ? { cursor } : {}),
            },
            { signal: cancel.signal, snapshotId }
          )
        } catch (error) {
          if (
            !(error instanceof TaskWorkspaceClientError) ||
            error.code !== 'cursor_invalid' ||
            !cursor ||
            cancel.signal.aborted ||
            !current()
          )
            throw error
          // Re-read only the first observation. Never replay task execution.
          result = await binding.transport.read(
            { threadId: binding.threadId, ...(sourceTarget ? { sourceTarget } : {}) },
            { signal: cancel.signal }
          )
          reset = true
        }
        if (!current() || cancel.signal.aborted) return
        setObservation(previous => {
          const keep =
            cursor &&
            !reset &&
            previous?.owner === identity &&
            previous.snapshot.snapshotId === result.snapshotId
          const cursors = keep ? previous.cursors.slice(0, page + 1) : [undefined]
          const currentPage = keep ? page : 0
          if (result.nextCursor) cursors[currentPage + 1] = result.nextCursor
          return { owner: identity, snapshot: result, page: currentPage, cursors }
        })
        if (reset) setNotice(identity)
      } catch (error) {
        if (!current()) return
        const code = error instanceof TaskWorkspaceClientError ? error.code : 'unavailable'
        setError({ owner: identity, code })
        if (code !== 'cancelled') setObservation(undefined)
      } finally {
        if (current()) setBusy(undefined)
        if (pending.current === cancel) pending.current = undefined
      }
    },
    [owner, identity, requestKey, sourceTarget]
  )
  useEffect(() => {
    if (!selectedThreadId || !target.serverId) return
    const actualTarget = {
      serverId: target.serverId,
      workspacePath: selectedWorkspacePath ?? target.workspacePath,
    }
    const binding: TaskWorkspaceViewBinding = {
      target: actualTarget,
      threadId: selectedThreadId,
      transport: createTaskWorkspaceTransport(actualTarget, () => owner.owns(binding)),
    }
    owner.install(binding)
    queueMicrotask(() => {
      if (owner.isCurrent(binding)) void load(undefined, 0, undefined, binding)
    })
    return () => {
      owner.detach(binding)
      binding.transport.dispose()
    }
  }, [owner, selectedThreadId, selectedWorkspacePath, target.serverId, target.workspacePath, load])
  const activeError = error?.owner === identity ? error.code : undefined
  const snapshot = visible?.snapshot
  useEffect(() => {
    if (!snapshot || !selectedThreadId) return
    let active = true
    let scheduled = false
    const subscription = subscribeLocalExecutorEvents(event => {
      if (
        !active ||
        !isCurrent() ||
        event.event !== 'response.integration.task_state' ||
        event.payload.deviceId !== target.serverId
      )
        return
      const incoming = event.payload.observation
      if (
        !isTaskStateObservation(incoming) ||
        incoming.reference.threadId !== selectedThreadId ||
        !sameTaskObservationScope(incoming.scope, snapshot.scope) ||
        scheduled
      )
        return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (active && isCurrent()) setRefresh(value => value + 1)
      })
    })
    return () => {
      active = false
      void subscription.then(unlisten => unlisten())
    }
  }, [snapshot, selectedThreadId, target.serverId, isCurrent])
  const open = (entry: TaskWorkspaceEntry) => {
    const binding = owner.read()
    if (!binding || !owner.isCurrent(binding)) return
    const ref = entry.reference
    if (ref.kind === 'agent') {
      if (ref.backgroundRun && onOpenAgentRun)
        onOpenAgentRun(structuredClone({ ...ref, backgroundRun: ref.backgroundRun }), {
          ...binding.target,
        })
    } else if (!canOpenReference || canOpenReference(ref, binding.target)) {
      onOpenReference?.(structuredClone(ref), { ...binding.target })
    }
  }
  const canOpen = (entry: TaskWorkspaceEntry) => {
    const binding = owner.read()
    if (!binding || !owner.isCurrent(binding)) return false
    const reference = entry.reference
    return reference.kind === 'agent'
      ? Boolean(reference.backgroundRun && onOpenAgentRun)
      : Boolean(
          onOpenReference && (!canOpenReference || canOpenReference(reference, binding.target))
        )
  }
  const currentTaskActions = () => {
    const binding = owner.read()
    const reference = snapshot?.thread.reference
    return binding && owner.isCurrent(binding) && reference?.kind === 'thread'
      ? renderTaskActions?.(binding.target, reference.threadId) : null
  }
  const statusText = (value: string | null | undefined) => {
    if (value == null) return t('unknown')
    return [
      'idle',
      'active',
      'running',
      'queued',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'paused',
      'outcome_unknown',
    ].includes(value)
      ? t(`nativeStates.${value}`)
      : value
  }
  const entryRow = (entry: TaskWorkspaceEntry, index: number) => (
    <tr
      key={referenceKey(entry.reference)}
      data-testid={`task-workspace-entry-${index}`}
      data-reference-kind={entry.reference.kind}
    >
      <td className="w-32 text-text-secondary">{t(`entryKinds.${entry.reference.kind}`)}</td>
      <td className="min-w-48">
        <h3 className="break-words text-sm font-medium text-text-primary">{entry.title}</h3>
        <details className="mt-2 text-sm text-text-secondary">
          <summary className="cursor-pointer" data-testid={`task-workspace-entry-details-${index}`}>
            {t('reference')}
          </summary>
          <p className="mt-2 break-all font-mono text-xs">{referenceKey(entry.reference)}</p>
          <p className="mt-1 break-words">
            {t('sourceMethod')}: {entry.sourceMethod}
          </p>
        </details>
      </td>
      <td className="min-w-32 text-text-secondary">
        {entry.sourceMethod === 'history/agents' && <span className="mb-1 block text-xs">{t('historicalStatus')}</span>}
        <span data-testid={`task-workspace-entry-status-${index}`} data-native-status={entry.nativeStatus}>
          {statusText(entry.nativeStatus)}
        </span>
      </td>
      <td className="w-40 text-right">
      {canOpen(entry) && (
        <Button
          data-testid={`task-workspace-open-reference-${index}`}
          className="min-h-11 md:min-h-0"
          variant="outline"
          size="sm"
          onClick={() => open(entry)}
        >
          {t('open')}
        </Button>
      )}
      </td>
    </tr>
  )
  return (
    <div
      ref={scrollRoot}
      className="h-full min-h-0 min-w-0 studio-page-gutter overflow-y-auto overscroll-y-contain bg-background py-6"
      data-testid="native-task-workspace"
    >
      <PageContent className="max-w-none space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="heading-base flex items-center gap-2 text-text-primary">
              <Columns3 className="size-5" aria-hidden="true" />
              {t('title')}
            </h1>
            <p className="mt-2 text-sm text-text-secondary">{t('description')}</p>
          </div>
          <div className="flex gap-2">
            {onNewTask && (
              <Button
                size="sm"
                className="min-h-11 md:min-h-0"
                onClick={() => {
                  if (isCurrent()) onNewTask()
                }}
              >
                <Plus aria-hidden="true" />
                {t('board.newTask')}
              </Button>
            )}
            <Button
              data-testid="task-workspace-refresh"
              className="min-h-11 md:min-h-0"
              variant="outline"
              size="sm"
              disabled={!selectedThreadId || reading}
              onClick={() => setRefresh(value => value + 1)}
            >
              <RefreshCw aria-hidden="true" />
              {t('refresh')}
            </Button>
            {reading && (
              <Button
                data-testid="task-workspace-cancel-read"
                className="min-h-11 md:min-h-0"
                variant="ghost"
                size="sm"
                onClick={() => pending.current?.abort()}
              >
                {t('cancelRead')}
              </Button>
            )}
          </div>
        </header>
        <TaskBoard
          tasks={choices}
          selectedKey={selected ? choiceKey(selected) : undefined}
          listingState={listingState}
          control={control}
          onSelect={task => {
            if (isCurrent()) {
              selectChoice(task)
              requestAnimationFrame(() => {
                // scrollIntoView would also move the surrounding application document.
                const root = scrollRoot.current, anchor = detailsAnchor.current
                if (isCurrent() && root && anchor && root.contains(anchor))
                  root.scrollTo?.({ top: Math.max(0, root.scrollTop + anchor.getBoundingClientRect().top
                    - root.getBoundingClientRect().top - 16), behavior: 'smooth' })
              })
            }
          }}
          canOpen={task => {
            const actualTarget = {
              serverId: target.serverId,
              workspacePath: task.workspacePath ?? target.workspacePath,
            }
            return (
              isCurrent() &&
              Boolean(
                onOpenReference &&
                canOpenReference?.({ kind: 'thread', threadId: task.threadId }, actualTarget)
              )
            )
          }}
          renderActions={renderTaskActions ? task => isCurrent() ? renderTaskActions({ ...target, workspacePath: task.workspacePath ?? target.workspacePath }, task.threadId) : null : undefined}
          onOpen={task => {
            const actualTarget = {
              serverId: target.serverId,
              workspacePath: task.workspacePath ?? target.workspacePath,
            }
            const reference = { kind: 'thread' as const, threadId: task.threadId }
            if (isCurrent() && canOpenReference?.(reference, actualTarget))
              onOpenReference?.(reference, actualTarget)
          }}
        />
        <div ref={detailsAnchor} className="scroll-mt-4" data-testid="task-workspace-details-anchor" />
        <details className="min-w-0">
          <summary className="cursor-pointer text-sm text-text-secondary">
            {t('board.quickSelect')}
          </summary>
          <div className="mt-3 min-w-0 space-y-2">
            <label htmlFor={selectId} className="block text-sm text-text-secondary">
              {t('choose')}
            </label>
            <SettingsSelect
              id={selectId}
              data-testid="task-workspace-thread-select"
              aria-label={t('choose')}
              icon={<FileStack className="size-4" aria-hidden="true" />}
              value={selected ? choiceKey(selected) : ''}
              className="w-full min-h-11 md:min-h-0"
              onChange={event => {
                const task = choices.find(item => choiceKey(item) === event.target.value)
                if (task) selectChoice(task)
                else setSelection(undefined)
              }}
            >
              <option value="">{t('choose')}</option>
              {choices.map(task => (
                <option key={choiceKey(task)} value={choiceKey(task)}>
                  {task.title}
                </option>
              ))}
            </SettingsSelect>
            {!choices.length && listingState === 'ready' && (
              <p className="text-sm text-text-secondary">{t('noTasks')}</p>
            )}
          </div>
        </details>
        {activeError && (
          <p
            role="alert"
            className="break-words text-sm text-destructive"
            data-testid="task-workspace-error"
          >
            {t(`errors.${activeError}`)}
          </p>
        )}
        {notice === identity && (
          <p
            role="status"
            className="text-sm text-text-secondary"
            data-testid="task-workspace-cursor-reset"
          >
            {t('cursorReset')}
          </p>
        )}
        {reading && (
          <p
            role="status"
            className="text-sm text-text-secondary"
            data-testid="task-workspace-reading"
          >
            {t('loading')}
          </p>
        )}
        {selectedThreadId && renderSourceRecords && isCurrent() && (
          <details className="studio-card-spacing min-w-0 rounded-lg border border-border">
            <summary className="cursor-pointer text-sm text-text-secondary">
              {t('facets.sources')}
            </summary>
            <div className="mt-3">
              {renderSourceRecords(
                {
                  serverId: target.serverId,
                  workspacePath: selectedWorkspacePath ?? target.workspacePath,
                },
                selectedThreadId,
                chooseSourceTarget
              )}
            </div>
          </details>
        )}
        {!selected && <p className="py-6 text-base text-text-secondary">{t('empty')}</p>}
        {selected?.workId && (
          <p className="py-6 text-sm text-text-secondary">{t('board.workDetailsUnavailable')}</p>
        )}
        {snapshot && (
          <div
            className="min-w-0 space-y-6"
            aria-busy={reading}
            data-testid="task-workspace-observation"
          >
            <TaskObservationOverview snapshot={snapshot} statusLabel={statusText(snapshot.thread.nativeStatus)}
              actions={<div className="flex flex-wrap items-center gap-2">{currentTaskActions()}{canOpen(snapshot.thread) && <Button data-testid="task-workspace-open-thread" className="min-h-11 md:min-h-0" variant="outline" size="sm" onClick={() => open(snapshot.thread)}>{t('open')}</Button>}</div>}
            />
            <section aria-label={t('related')} className="space-y-3">
              <h2 className="text-lg font-medium text-text-primary">{t('related')}</h2>
              <TaskWorkspaceTable label={t('related')} testId="task-workspace-related-table"
                columns={[t('tableColumns.kind'), t('tableColumns.name'), t('tableColumns.state'), t('tableColumns.actions')]}
                emptyMessage={!snapshot.entries.length ? t('noEntries') : undefined}>
                {snapshot.entries.map(entryRow)}
              </TaskWorkspaceTable>
              <nav
                className="mt-3 flex flex-wrap items-center justify-between gap-3"
                aria-label={t('page', { page: visible!.page + 1 })}
              >
                <p className="text-sm text-text-secondary" data-testid="task-workspace-page">
                  {t('page', { page: visible!.page + 1 })}
                </p>
                <div className="flex gap-2">
                  <Button
                    data-testid="task-workspace-previous"
                    className="min-h-11 md:min-h-0"
                    variant="ghost"
                    size="sm"
                    disabled={reading || visible!.page === 0}
                    onClick={() =>
                      void load(
                        visible!.cursors[visible!.page - 1],
                        visible!.page - 1,
                        visible!.cursors[visible!.page - 1] ? snapshot.snapshotId : undefined
                      )
                    }
                  >
                    {t('previous')}
                  </Button>
                  <Button
                    data-testid="task-workspace-next"
                    className="min-h-11 md:min-h-0"
                    variant="outline"
                    size="sm"
                    disabled={reading || !snapshot.nextCursor}
                    onClick={() =>
                      void load(
                        snapshot.nextCursor ?? undefined,
                        visible!.page + 1,
                        snapshot.snapshotId
                      )
                    }
                  >
                    {t('next')}
                  </Button>
                </div>
              </nav>
            </section>
            <section aria-label={t('artifacts')} className="space-y-3">
              <h2 className="text-lg font-medium text-text-primary">{t('artifacts')}</h2>
              <TaskWorkspaceTable label={t('artifacts')} testId="task-workspace-artifacts-table"
                columns={[t('tableColumns.name'), t('tableColumns.revision'), t('tableColumns.actions')]}
                emptyMessage={!snapshot.artifactRefs.length ? t('noArtifacts') : undefined}>
                {snapshot.artifactRefs.map((reference, index) => <tr key={`${reference.kind}:${reference.id}:${reference.revision ?? ''}`}>
                  <td className="min-w-48">
                    <span className="font-medium">{t('artifactItem', { index: index + 1 })}</span>
                    <p className="mt-1 break-all text-xs text-text-secondary">{reference.id}</p>
                  </td>
                  <td className="text-text-secondary">{reference.revision ?? t('unknown')}</td>
                  <td className="w-40 text-right">
                  {onOpenArtifacts && (
                    <Button
                      data-testid={index === 0 ? 'task-workspace-open-artifacts' : `task-workspace-open-artifacts-${index}`}
                      className="min-h-11 md:min-h-0"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const binding = owner.read()
                        if (binding && owner.isCurrent(binding))
                          onOpenArtifacts(
                            structuredClone([reference]),
                            binding.target,
                            binding.threadId
                          )
                      }}
                    >
                      {t('openArtifacts')}
                    </Button>
                  )}
                  </td>
                </tr>)}
              </TaskWorkspaceTable>
            </section>
            <section aria-label={t('interactions')} className="space-y-3">
              <h2 className="text-lg font-medium text-text-primary">{t('interactions')}</h2>
              {renderPendingInteractions ? (
                renderPendingInteractions(
                  {
                    serverId: target.serverId,
                    workspacePath: selectedWorkspacePath ?? target.workspacePath,
                  },
                  snapshot.thread.reference.threadId
                )
              ) : (
                <TaskWorkspaceTable label={t('interactions')} testId="task-workspace-interactions-table"
                  columns={[t('tableColumns.prompt')]}
                  emptyMessage={!snapshot.runtime?.pendingInteractions ? t('interactionsUnknown')
                    : !snapshot.runtime.pendingInteractions.length ? t('noInteractions') : undefined}>
                  {snapshot.runtime?.pendingInteractions?.map(item => <tr key={`${item.interactionId}@${item.revision}`}>
                    <td className="whitespace-pre-wrap break-words">{item.prompt}</td>
                  </tr>)}
                </TaskWorkspaceTable>
              )}
            </section>

            <details className="border-t border-border pt-4">
              <summary
                data-testid="task-workspace-records"
                className="cursor-pointer text-sm text-text-secondary"
              >
                {t('records')}
              </summary>
              <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 text-sm text-text-secondary">
                <div>
                  <dt>{t('observedAt')}</dt>
                  <dd>{new Date(snapshot.observedAtMs).toLocaleString(i18n.language)}</dd>
                </div>
                <div>
                  <dt>{t('snapshot')}</dt>
                  <dd className="break-all font-mono text-xs">{snapshot.snapshotId}</dd>
                </div>
                <div>
                  <dt>{t('sourceMethod')}</dt>
                  <dd>{snapshot.thread.sourceMethod}</dd>
                </div>
                <div>
                  <dt>{t('taskCapabilityScopeMode')}</dt>
                  <dd>{snapshot.sourceSelection?.selection.mode ?? t('unknown')}</dd>
                </div>
                {snapshot.runtime && (
                  <div>
                    <dt>{t('facets.runtime')}</dt>
                    <dd>{snapshot.runtime.state}</dd>
                  </div>
                )}
              </dl>
            </details>
          </div>
        )}
        <p className="text-sm text-text-secondary">{t('readOnly')}</p>
      </PageContent>
    </div>
  )
}
