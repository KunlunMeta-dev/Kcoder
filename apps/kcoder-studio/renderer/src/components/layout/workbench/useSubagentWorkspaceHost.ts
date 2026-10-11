import { normalizeRuntimeSubagentStatus } from '../pane/subagentState'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { useSubagentConversation } from '@/features/subagents/useSubagentConversation'

type Api = ReturnType<typeof createRuntimeWorkApi>
const terminal = new Set(['applied', 'rejected', 'dead_letter', 'cancelled', 'closed'])
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
  parentLabel?: string
) {
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
    scope: string
    value: RuntimeSubagentListResponse
    generation: number
    connected: boolean
  } | null>(null)
  const [commands, setCommands] = useState<{
    scope: string
    items: SubagentCommand[]
    epoch: number
    count: number
    limit: number
  } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const generation = useRef(0)
  const authority = useRef<{ scope: string; journalScope: string } | null>(null)
  const snapshotRevisions = useRef(new Map<string, string>())
  const current = useRef({ api, address, taskScope })
  useLayoutEffect(() => {
    current.current = { api, address, taskScope }
  }, [api, address, taskScope])
  const selectedId = selected?.scope === taskScope ? selected.id : undefined
  const currentObservation = observation?.scope === taskScope ? observation : null
  const summary = currentObservation?.value.agents.find(item => item.agentId === selectedId)
  const conversationSupported = Boolean(currentObservation?.value.capabilities.conversationStream)
  const conversation = useSubagentConversation(
    api,
    address,
    selectedId,
    conversationSupported && Boolean(summary),
    { runId: summary?.backgroundRun?.runId, ownerScope: currentObservation?.value.journalScope }
  )
  const latestAssistant = conversation.messages?.reduce<
    import('@/types/workbench').WorkbenchMessage | undefined
  >((previous, message) => (message.role === 'assistant' ? message : previous), undefined)
  const journalScope =
    summary && currentObservation
      ? `${currentObservation.value.journalScope}:${JSON.stringify([summary.agentId, summary.presentation?.journalScope ?? 'legacy'])}`
      : ''
  const history = commands?.scope === journalScope ? commands : null
  const journalRef = useRef<{ scope: string; journal: SubagentCommandJournal } | null>(null)
  const valid = (scope: string, requestGeneration: number) =>
    current.current.taskScope === scope && generation.current === requestGeneration

  const refreshList = useCallback(async () => {
    const host = current.current
    if (!host.api || !host.address || host.taskScope !== taskScope) return
    const captured = generation.current
    try {
      const value = await host.api.listRuntimeSubagents({ address: host.address })
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
        setObservation({ scope: taskScope, value, generation: generation.current, connected: true })
      }
    } catch {
      if (valid(taskScope, captured))
        setObservation(previous =>
          previous?.scope === taskScope ? { ...previous, connected: false } : null
        )
    }
  }, [taskScope])
  useEffect(() => {
    generation.current += 1
    snapshotRevisions.current.clear()
    const initial = setTimeout(() => void refreshList(), 0)
    const timer = setInterval(() => void refreshList(), 2000)
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
      clearTimeout(initial)
      clearInterval(timer)
      stop()
    }
  }, [refreshList, address?.deviceId])

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
  const refreshCommands = useCallback(async () => {
    if (
      !api ||
      !address ||
      !summary ||
      !currentObservation?.connected ||
      !currentObservation.value.capabilities.receipts
    )
      return
    const captured = generation.current
    const agentId = summary.agentId
    let offset = 0
    let epoch: number | undefined
    let retainedCount = 0
    let limit = 256
    const receipts: SubagentCommand[] = []
    // The server retains at most 256 identities. Continuation always carries its epoch.
    for (let page = 0; page < 4; page += 1) {
      const result = await api.listRuntimeSubagentCommands({
        address,
        agentId,
        offset,
        limit: 64,
        receiptEpoch: epoch,
      })
      if (!valid(taskScope, captured)) return
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
        address,
        agentId,
        clientMessageId: intent.clientMessageId,
      })
      if (!valid(taskScope, captured)) return
      if (observed.receiptEpoch !== epoch) throw new Error('subagent command epoch changed')
      const command = observed.receipt
        ? receiptCommand(observed.receipt)
        : { ...intent, message: '', status: 'unknown' }
      if (observed.receipt) recovery.update(command)
      receipts.push(command)
    }
    if (valid(taskScope, captured))
      setCommands(previous =>
        previous?.scope === journalScope && previous.epoch > (epoch ?? 0)
          ? previous
          : {
              scope: journalScope,
              items: receipts,
              epoch: epoch ?? 0,
              count: retainedCount,
              limit,
            }
      )
    // Observations may change tool/status metadata without resetting this journal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    address,
    summary?.agentId,
    journalScope,
    currentObservation?.connected,
    currentObservation?.value.capabilities.receipts,
    taskScope,
  ])
  useEffect(() => {
    const initial = setTimeout(() => void refreshCommands().catch(() => undefined), 0)
    const timer = setInterval(() => void refreshCommands().catch(() => undefined), 2000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [refreshCommands])

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
  const workspace: SubagentWorkspaceProps | null =
    summary && currentObservation
      ? {
          agent: {
            ...statusOf(
              summary,
              activity.find(item => item.agentId === summary.agentId)
            ),
            ...(conversation.observedActive === false &&
            normalizeRuntimeSubagentStatus(summary.status) === 'running'
              ? {
                  status:
                    latestAssistant?.status === 'failed' ||
                    latestAssistant?.runtimeStatus === 'cancelled'
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
          conversationMessages: conversationSupported ? (conversation.messages ?? []) : undefined,
          conversationActive: conversation.active,
          conversationLoading: conversation.loading,
          conversationError: conversation.error,
          conversationKey: conversation.key,
          toolsCatalogTaskId: address?.taskId,
          toolsCatalogServerId: address?.deviceId,
          draft: drafts[journalScope] ?? '',
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
            void refreshList()
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
            setCommands({
              scope: journalScope,
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
            await refreshList()
            if (!valid(taskScope, host.generation)) throw new Error('subagent target changed')
            return result
          },
          onClose: () => setSelected(null),
        }
      : null
  const statuses = currentObservation
    ? currentObservation.value.agents.map(item =>
        statusOf(
          item,
          activity.find(agent => agent.agentId === item.agentId)
        )
      )
    : activity
  return {
    statuses,
    workspace,
    sourceMatches: (source?: RuntimeSourceAgent) =>
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
    openAgent: (id: string, workflowRunId?: string, workflowNodeId?: string) => {
      setSelected({ scope: taskScope, id, workflowRunId, workflowNodeId })
      void refreshList()
    },
  }
}
