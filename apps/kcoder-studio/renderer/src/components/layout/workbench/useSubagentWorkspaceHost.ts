import { normalizeRuntimeSubagentStatus } from '../pane/subagentState'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeSubagentArtifactResponse, RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import type {
  RuntimeSubagentListResponse,
  RuntimeSubagentReceipt,
  RuntimeSubagentSummary,
  RuntimeSourceAgent,
} from '@/types/subagents'
import { receiptAsSteer } from '@/types/subagents'
import { SubagentCommandJournal } from '@/features/subagents/subagentCommandJournal'
import type { SubagentWorkspaceProps } from '@/features/subagents/SubagentWorkspace'
import type {
  SubagentArtifactPage,
  SubagentCommand,
} from '@/features/subagents/subagentWorkspaceState'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { useSubagentConversationSource } from '@/features/subagents/useSubagentConversation'
import { useRuntimeTaskReadAddress } from '../pane/useRuntimeTaskReadAddress'

type Api = ReturnType<typeof createRuntimeWorkApi>
type CommandReadOwner = Readonly<{ api: Api | undefined; address: RuntimeTaskAddress | null; scope: string }>
type ListRefreshCause = 'poll' | 'event' | 'mutation'
const terminal = new Set(['applied', 'rejected', 'dead_letter', 'cancelled', 'closed'])

/** Reset one presentation deadline after any read; the original refresh retains request ownership. */
function useSubagentRefresh(
  refresh: (cause?: ListRefreshCause) => Promise<void>, active: boolean, initialCause: 'poll' | 'event'
) {
  const clock = useRef<{ refresh: typeof refresh; schedule: (delay?: number) => void } | null>(null)
  const read = useCallback((cause?: ListRefreshCause) => {
    const lifetime = clock.current?.refresh === refresh ? clock.current : null
    lifetime?.schedule()
    return refresh(cause).finally(() => lifetime?.schedule(15_000))
  }, [refresh])
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delay?: number) => {
      clearTimeout(timer)
      if (!stopped && delay !== undefined && document.visibilityState !== 'hidden')
        timer = setTimeout(() => { void read('poll').catch(() => undefined) }, delay)
    }
    const lifetime = { refresh, schedule }
    clock.current = lifetime
    const displayRead = (cause: 'poll' | 'event') => {
      if (document.visibilityState !== 'hidden') void read(cause).catch(() => undefined)
      else schedule()
    }
    const foreground = () => displayRead('poll')
    timer = setTimeout(() => displayRead(initialCause), 0)
    document.addEventListener('visibilitychange', foreground)
    window.addEventListener('focus', foreground)
    return () => {
      stopped = true
      schedule()
      if (clock.current === lifetime) clock.current = null
      document.removeEventListener('visibilitychange', foreground)
      window.removeEventListener('focus', foreground)
    }
  }, [active, initialCause, read, refresh])
  return read
}

function activityRevision(activity: RuntimeSubagentStatus[], selectedId: string | undefined) {
  return JSON.stringify(activity.map(({ updatedAtMs, ...status }) => ({
    ...status,
    // Only the open worker needs fresh progress details on timestamp-only updates.
    ...(status.agentId === selectedId ? { updatedAtMs } : {}),
  })).sort((left, right) => left.id.localeCompare(right.id)))
}
function receiptCommand(receipt: RuntimeSubagentReceipt): SubagentCommand {
  return {
    clientMessageId: receipt.clientMessageId,
    messageId: receipt.messageId,
    message: receipt.bodySummary,
    status: receipt.status,
    createdAtMs: receipt.acceptedAtMs,
  }
}
function statusOf(
  summary: RuntimeSubagentSummary,
  activity?: RuntimeSubagentStatus
): RuntimeSubagentStatus {
  return {
    ...activity,
    id: summary.agentId,
    agentId: summary.agentId,
    agentPath: summary.agentId,
    agentName:
      summary.agentName ||
      summary.presentation?.goal?.split('\n')[0] ||
      activity?.agentName ||
      summary.agentId,
    status: normalizeRuntimeSubagentStatus(summary.status),
    ...(summary.headStatus ? { steerStatus: summary.headStatus } : {}),
  }
}
function artifactPage(value: RuntimeSubagentArtifactResponse): SubagentArtifactPage {
  return {
    content: value.content,
    truncated: value.truncated,
    offset: value.offset ?? 0,
    nextOffset: value.nextOffset,
    revision: value.revision ?? 'legacy-single-page',
    size: value.size ?? new TextEncoder().encode(value.content).byteLength,
  }
}

/** Presentation of existing workers. The parent session and composer stay mounted. */
export function useSubagentWorkspaceHost(
  api: Api | undefined,
  address: RuntimeTaskAddress | null | undefined,
  activity: RuntimeSubagentStatus[],
  parentLabel?: string,
  active = true
) {
  const readAddress = useRuntimeTaskReadAddress(address)
  const taskScope = address
    ? JSON.stringify([address.deviceId, address.taskId, address.threadId ?? null])
    : ''
  const [selected, setSelected] = useState<{
    scope: string
    id: string
    workflowRunId?: string
    workflowNodeId?: string
  } | null>(null)
  const [observation, setObservation] = useState<{
    api: Api
    address: RuntimeTaskAddress
    scope: string
    value: RuntimeSubagentListResponse
    generation: number
    connected: boolean
  } | null>(null)
  const [commands, setCommands] = useState<{
    owner: CommandReadOwner
    items: SubagentCommand[]
    epoch: number
    count: number
    limit: number
  } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const generation = useRef(0)
  const refreshFlight = useRef<{
    scope: string
    generation: number
    trailing: false | ListRefreshCause
    promise: Promise<void>
  } | null>(null)
  const authority = useRef<{ scope: string; journalScope: string } | null>(null)
  const snapshotRevisions = useRef(new Map<string, string>())
  const current = useRef({ api, address, readAddress, taskScope, active, commandOwner: null as CommandReadOwner | null })
  const selectedId = selected?.scope === taskScope ? selected.id : undefined
  const currentObservation = observation?.scope === taskScope && observation.api === api && observation.address === readAddress ? observation : null
  const summary = currentObservation?.value.agents.find(item => item.agentId === selectedId)
  const conversationSupported = Boolean(currentObservation?.value.capabilities.conversationStream)
  // Streaming increments reach the workspace through `conversationSource`; this pane
  // root re-renders only when the observation's lifecycle summary changes.
  const { handle: conversationSource, summary: conversation } = useSubagentConversationSource(
    api,
    readAddress,
    selectedId,
    conversationSupported && Boolean(summary),
    { runId: summary?.backgroundRun?.runId, ownerScope: currentObservation?.value.journalScope },
    active
  )
  const journalScope =
    summary && currentObservation
      ? `${currentObservation.value.journalScope}:${JSON.stringify([summary.agentId, summary.presentation?.journalScope ?? 'legacy'])}`
      : ''
  const commandOwner = useMemo<CommandReadOwner>(
    () => ({ api, address: readAddress, scope: journalScope }),
    [api, readAddress, journalScope]
  )
  useLayoutEffect(() => {
    current.current = { api, address, readAddress, taskScope, active, commandOwner }
  }, [api, address, readAddress, taskScope, active, commandOwner])
  const history = commands?.owner === commandOwner ? commands : null
  const journalRef = useRef<{ scope: string; journal: SubagentCommandJournal } | null>(null)
  const valid = useCallback((scope: string, requestGeneration: number) =>
    current.current.api === api && current.current.readAddress === readAddress &&
      current.current.taskScope === scope && generation.current === requestGeneration, [api, readAddress])

  const readList = useCallback(
    (cause: ListRefreshCause = 'event') => {
      const host = current.current
      if (!host.api || !host.readAddress || !valid(taskScope, generation.current)) return Promise.resolve()
      const captured = generation.current
      const existing = refreshFlight.current
      if (existing?.scope === taskScope && existing.generation === captured) {
        if (cause !== 'poll' && existing.trailing !== 'mutation') existing.trailing = cause
        return existing.promise
      }

      const flight: NonNullable<typeof refreshFlight.current> = {
        scope: taskScope,
        generation: captured,
        trailing: false,
        promise: Promise.resolve(),
      }
      const readOnce = async () => {
        const currentHost = current.current
        if (
          !currentHost.api ||
          !currentHost.readAddress ||
          currentHost.taskScope !== taskScope ||
          !valid(taskScope, captured)
        )
          return
        try {
          const value = await currentHost.api.listRuntimeSubagents({ address: currentHost.readAddress })
          if (valid(taskScope, captured)) {
            if (
              authority.current?.scope === taskScope &&
              authority.current.journalScope !== value.journalScope
            ) {
              generation.current += 1
              setSelected(null)
              setCommands(null)
              setDrafts({})
              journalRef.current = null
              snapshotRevisions.current.clear()
            }
            authority.current = { scope: taskScope, journalScope: value.journalScope }
            setObservation({
              api: currentHost.api,
              address: currentHost.readAddress,
              scope: taskScope,
              value,
              generation: generation.current,
              connected: true,
            })
          }
        } catch {
          if (valid(taskScope, captured))
            setObservation(previous =>
              previous?.scope === taskScope ? { ...previous, connected: false } : null
            )
        }
      }

      const run = async () => {
        let next: false | ListRefreshCause = cause
        while (next && valid(taskScope, captured)) {
          // Hidden presentation waits; an accepted mutation still needs its authoritative read.
          if (next !== 'mutation' && (!current.current.active || document.visibilityState === 'hidden')) return
          flight.trailing = false
          await readOnce()
          next = flight.trailing
        }
      }
      flight.promise = Promise.resolve()
        .then(run)
        .finally(() => {
          if (refreshFlight.current === flight) refreshFlight.current = null
        })
      refreshFlight.current = flight
      return flight.promise
    },
    [taskScope, valid]
  )
  const refreshList = useSubagentRefresh(readList, active, 'event')
  useEffect(() => {
    generation.current += 1
    const effectGeneration = generation.current
    snapshotRevisions.current.clear()
    const stop = listenAccountContextChanges(target => {
      if (target !== address?.deviceId) return
      generation.current += 1
      // Never render one account's public artifacts or recovery handles for another.
      setSelected(null)
      setObservation(null)
      setCommands(null)
      setDrafts({})
      journalRef.current = null
      authority.current = null
      snapshotRevisions.current.clear()
    })
    return () => {
      generation.current += 1
      if (
        refreshFlight.current?.scope === taskScope &&
        refreshFlight.current.generation === effectGeneration
      )
        refreshFlight.current = null
      stop()
    }
  }, [refreshList, address?.deviceId, taskScope])

  const previousActivity = useRef(activity)
  useEffect(() => {
    const previous = previousActivity.current
    previousActivity.current = activity
    if (previous === activity || !active || document.visibilityState === 'hidden') return
    if (activityRevision(previous, selectedId) !== activityRevision(activity, selectedId))
      void refreshList()
  }, [activity, selectedId, active, refreshList])

  const requireHost = () => {
    if (!currentObservation || !valid(taskScope, currentObservation.generation))
      throw new Error('subagent account or target changed')
    if (
      !api ||
      !address ||
      !summary ||
      !currentObservation?.connected ||
      selectedId !== summary.agentId
    )
      throw new Error('subagent host is disconnected')
    return { api, address, agentId: summary.agentId, generation: generation.current }
  }
  const journal = () => {
    if (!journalScope) throw new Error('subagent command journal scope is unavailable')
    if (journalRef.current?.scope !== journalScope)
      journalRef.current = {
        scope: journalScope,
        journal: new SubagentCommandJournal(window.localStorage, journalScope),
      }
    return journalRef.current.journal
  }
  const commandFlight = useRef<{
    owner: CommandReadOwner; generation: number; promise: Promise<void>; trailing: boolean
  } | null>(null)
  const readCommands = useCallback((cause: ListRefreshCause = 'event'): Promise<void> => {
    if (
      !api ||
      !readAddress ||
      !summary ||
      !currentObservation?.connected ||
      !currentObservation.value.capabilities.receipts
    )
      return Promise.resolve()
    const captured = generation.current
    const readIsCurrent = () => valid(taskScope, captured)
    if (!readIsCurrent()) return Promise.resolve()
    const existing = commandFlight.current
    if (existing?.owner === commandOwner && existing.generation === captured) {
      if (cause !== 'poll') existing.trailing = true
      return existing.promise
    }
    const flight = { owner: commandOwner, generation: captured, promise: Promise.resolve(), trailing: false }
    const readOnce = async () => {
      if (!readIsCurrent()) return
      const agentId = summary.agentId
      let offset = 0
      let epoch: number | undefined
      let retainedCount = 0
      let limit = 256
      const receipts: SubagentCommand[] = []
      // The server retains at most 256 identities. Continuation always carries its epoch.
      for (let page = 0; page < 4; page += 1) {
        const result = await api.listRuntimeSubagentCommands({
          address: readAddress,
          agentId,
          offset,
          limit: 64,
          receiptEpoch: epoch,
        })
        if (!readIsCurrent()) return
        if (
          !Number.isSafeInteger(result.receiptEpoch) ||
          result.receiptEpoch < 0 ||
          result.retainedCount < 0 ||
          result.retainedCount > 256 ||
          result.retainedLimit > 256
        )
          throw new Error('subagent command journal bounds are invalid')
        if (epoch !== undefined && epoch !== result.receiptEpoch)
          throw new Error('subagent command epoch changed')
        epoch = result.receiptEpoch
        retainedCount = result.retainedCount
        limit = result.retainedLimit
        receipts.push(...result.receipts.map(receiptCommand))
        if (result.nextOffset === undefined) break
        if (result.nextOffset <= offset) throw new Error('subagent command cursor did not advance')
        offset = result.nextOffset
      }
      const recovery = journal()
      recovery.retireBeforeEpoch(epoch ?? 0)
      const pending = recovery.load()
      for (const intent of pending) {
        const receipt = receipts.find(item => item.clientMessageId === intent.clientMessageId)
        if (receipt) {
          recovery.update(receipt)
          continue
        }
        const observed = await api.readRuntimeSubagentCommand({
          address: readAddress,
          agentId,
          clientMessageId: intent.clientMessageId,
        })
        if (!readIsCurrent()) return
        if (observed.receiptEpoch !== epoch) throw new Error('subagent command epoch changed')
        const command = observed.receipt
          ? receiptCommand(observed.receipt)
          : { ...intent, message: '', status: 'unknown' }
        if (observed.receipt) recovery.update(command)
        receipts.push(command)
      }
      if (readIsCurrent() && current.current.commandOwner === commandOwner)
        setCommands(previous =>
          previous?.owner === commandOwner && previous.epoch > (epoch ?? 0)
            ? previous
            : {
                owner: commandOwner,
                items: receipts,
                epoch: epoch ?? 0,
                count: retainedCount,
                limit,
              }
        )
    }
    flight.promise = Promise.resolve().then(async () => {
      do {
        flight.trailing = false
        await readOnce()
      } while (flight.trailing && readIsCurrent())
    }).finally(() => {
      if (commandFlight.current === flight) commandFlight.current = null
    })
    commandFlight.current = flight
    return flight.promise
    // Observations may change tool/status metadata without resetting this journal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    readAddress,
    commandOwner,
    summary?.agentId,
    journalScope,
    currentObservation?.connected,
    currentObservation?.value.capabilities.receipts,
    taskScope,
  ])
  const refreshCommands = useSubagentRefresh(readCommands, active, 'poll')

  const read = async (
    agentId: string,
    kind: 'output' | 'transcript',
    offset: number,
    tail = false
  ) => {
    const host = requireHost()
    if (agentId !== host.agentId) throw new Error('subagent view identity changed')
    const key = `${journalScope}:${kind}`
    const value = await host.api.readSubagentArtifact({
      address: host.address,
      agentId,
      kind,
      limit: 64 * 1024,
      ...(tail
        ? { tail: true }
        : { offset, ...(offset > 0 ? { revision: snapshotRevisions.current.get(key) } : {}) }),
    })
    if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
    if (value.revision) snapshotRevisions.current.set(key, value.revision)
    return artifactPage(value)
  }
  const agentActivity = summary
    ? activity.find(item => item.agentId === summary.agentId)
    : undefined
  const draft = drafts[journalScope] ?? ''
  // Every closure below reads only values listed in the dependencies, so a stable object
  // lets the memoized workspace skip renders caused by unrelated parent-pane updates.
  const workspace = useMemo<SubagentWorkspaceProps | null>(() => summary && currentObservation
      ? {
          agent: {
            ...statusOf(summary, agentActivity),
            ...(conversation.observedActive === false &&
            normalizeRuntimeSubagentStatus(summary.status) === 'running'
              ? {
                  status: conversation.latestAssistantInterrupted
                    ? ('interrupted' as const)
                    : ('done' as const),
                }
              : {}),
          },
          parentLabel,
          role: summary.presentation?.role,
          goal: summary.presentation?.goal,
          directory: summary.presentation?.directory,
          progress: summary.presentation?.progress,
          runId: summary.backgroundRun?.runId,
          workflowRunId: selected?.workflowRunId,
          workflowNodeId: selected?.workflowNodeId,
          connected: currentObservation.connected && !conversation.error,
          conversationSource: conversationSupported ? conversationSource : undefined,
          conversationActive: conversation.active,
          conversationLoading: conversation.loading,
          conversationError: conversation.error,
          conversationKey: conversation.key,
          conversationRunId: conversation.runId,
          conversationActivityTaskId: conversation.activityTaskId,
          toolsCatalogTaskId: address?.taskId,
          toolsCatalogServerId: address?.deviceId,
          draft,
          onDraftChange: value =>
            setDrafts(current => ({
              ...current,
              [journalScope]:
                typeof value === 'function' ? value(current[journalScope] ?? '') : value,
            })),
          canSteer:
            conversationSupported &&
            !conversation.error &&
            currentObservation.value.capabilities.steering &&
            currentObservation.value.capabilities.receipts &&
            history !== null,
          canReadTranscript: currentObservation.value.capabilities.publicTranscript,
          onReadArtifact: (id, kind, offset) => read(id, kind, offset),
          onReadLatest: async (id, kind) => {
            const host = requireHost()
            if (id !== host.agentId) throw new Error('subagent view identity changed')
            return read(id, kind, 0, currentObservation.value.capabilities.pages)
          },
          onSteer: async (id, message, clientMessageId) => {
            const host = requireHost()
            if (id !== host.agentId) throw new Error('subagent view identity changed')
            const receipt = await host.api.steerRuntimeSubagent({
              address: host.address,
              agentId: id,
              message,
              clientMessageId,
            })
            if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
            void refreshList('mutation')
            void refreshCommands().catch(() => undefined)
            return receipt
          },
          onLookupCommand: async (id, clientMessageId) => {
            const host = requireHost()
            if (id !== host.agentId) throw new Error('subagent view identity changed')
            const value = await host.api.readRuntimeSubagentCommand({
              address: host.address,
              agentId: id,
              clientMessageId,
            })
            if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
            return value.receipt ? { ...receiptAsSteer(value.receipt), agentId: id } : null
          },
          commandHistory: history?.items,
          commandEpoch: history?.epoch,
          retainedCommandCount: history?.count,
          commandLimit: history?.limit,
          canArchiveCommands:
            currentObservation.value.capabilities.receipts &&
            Boolean(
              history &&
              history.items.length === history.count &&
              history.items.every(item => terminal.has(item.status))
            ),
          onArchiveCommands: async (confirmedMessageIds, expectedEpoch) => {
            const host = requireHost()
            const value = await host.api.archiveRuntimeSubagentCommands({
              address: host.address,
              agentId: host.agentId,
              confirmedMessageIds,
              expectedEpoch,
            })
            if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
            if (
              !Number.isSafeInteger(value.receiptEpoch) ||
              value.receiptEpoch !== expectedEpoch + 1
            )
              throw new Error('subagent command archive epoch is unconfirmed')
            journal().retireBeforeEpoch(value.receiptEpoch)
            if (current.current.commandOwner === commandOwner) setCommands({
              owner: commandOwner,
              items: [],
              epoch: value.receiptEpoch,
              count: 0,
              limit: history?.limit ?? 256,
            })
            await refreshCommands()
            return true
          },
          onCommandIntent: command => {
            requireHost()
            journal().remember(command)
          },
          onCommandUpdate: command => {
            requireHost()
            journal().update(command)
          },
          canStop:
            conversation.observedActive !== false &&
            summary.presentation?.canStop === true &&
            currentObservation.value.capabilities.stop &&
            Boolean(summary.backgroundRun),
          onStop: async id => {
            const host = requireHost()
            if (id !== host.agentId || !summary.backgroundRun || !summary.presentation?.canStop)
              throw new Error('subagent cannot be stopped independently')
            const result = await host.api.stopRuntimeSubagent({
              address: host.address,
              agentId: id,
              expectedBackgroundRun: summary.backgroundRun,
            })
            if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
            await refreshList('mutation')
            if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
            return result
          },
          onClose: () => setSelected(null),
        }
      : null,
    // `read`, `requireHost` and `journal` are rebuilt from the listed values each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      summary,
      currentObservation,
      agentActivity,
      conversation,
      conversationSource,
      conversationSupported,
      parentLabel,
      selected,
      address,
      api,
      draft,
      journalScope,
      history,
      selectedId,
      taskScope,
      refreshList,
      refreshCommands,
    ]
  )
  const statuses = currentObservation
    ? currentObservation.value.agents.map(item =>
        statusOf(
          item,
          activity.find(agent => agent.agentId === item.agentId)
        )
      )
    : activity
  const sourceMatches = useCallback(
    (source?: RuntimeSourceAgent) =>
      Boolean(
        source &&
        summary &&
        currentObservation?.connected &&
        source.agentId === summary.agentId &&
        source.parentSessionId === currentObservation.value.threadId &&
        (source.backgroundRun
          ? source.backgroundRun.runId === summary.backgroundRun?.runId &&
            source.backgroundRun.agentId === summary.agentId &&
            source.backgroundRun.parentSessionId === currentObservation.value.threadId
          : !summary.backgroundRun)
      ),
    [summary, currentObservation]
  )
  return {
    statuses,
    workspace,
    sourceMatches,
    openAgent: (id: string, workflowRunId?: string, workflowNodeId?: string) => {
      setSelected({ scope: taskScope, id, workflowRunId, workflowNodeId })
      void refreshList()
    },
  }
}
