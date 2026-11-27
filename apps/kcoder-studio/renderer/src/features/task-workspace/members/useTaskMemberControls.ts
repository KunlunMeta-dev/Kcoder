import { useEffect, useMemo, useState } from 'react'
import { createRandomUuid } from '@/lib/random-id'
import { SubagentCommandJournal } from '@/features/subagents/subagentCommandJournal'
import type { SubagentCommand } from '@/features/subagents/subagentWorkspaceState'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import { receiptAsSteer } from '@/types/subagents'
import type { BackgroundRunKey } from '../../../../../shared/generated/contracts'

type Api = Partial<Pick<ReturnType<typeof createRuntimeWorkApi>,
  'steerRuntimeSubagent' | 'readRuntimeSubagentCommand' | 'stopRuntimeSubagent'>>

/** Native receipts remain authoritative; the UI journal holds lookup handles only. */
export function useTaskMemberControls(input: {
  api?: Api
  address: RuntimeTaskAddress
  run: BackgroundRunKey
  journalScope?: string
  supported: boolean
  isCurrent: () => boolean
}) {
  const { api, address, run, supported, isCurrent } = input
  const key = JSON.stringify([input.journalScope, address, run])
  const journal = useMemo(() => input.journalScope
    ? new SubagentCommandJournal(window.localStorage, key) : undefined, [key, input.journalScope])
  const [observed, setObserved] = useState<{ key: string; epoch: number; history: SubagentCommand[] }>()
  const current = () => {
    if (!supported || !api?.readRuntimeSubagentCommand || !journal || !isCurrent()
      || address.threadId !== run.parentSessionId) throw new Error('Exact member control unavailable')
  }
  const same = (value: { parentSessionId: string; agentId: string; runId: string } | undefined) =>
    value?.parentSessionId === run.parentSessionId && value.agentId === run.agentId && value.runId === run.runId
  useEffect(() => {
    let active = true
    if (!supported || !api?.readRuntimeSubagentCommand || !journal) return
    const probe = `epoch:${createRandomUuid()}`
    void api.readRuntimeSubagentCommand({ address: { ...address }, agentId: run.agentId,
      expectedBackgroundRun: { ...run }, clientMessageId: probe }).then(value => {
      if (!active || !isCurrent()) return
      if (value.threadId !== run.parentSessionId || value.agentId !== run.agentId
        || value.clientMessageId !== probe || !Number.isSafeInteger(value.receiptEpoch) || value.receiptEpoch < 0)
        throw new Error('Exact member receipt scope changed')
      setObserved({ key, epoch: value.receiptEpoch, history: journal.load().map(command => ({
        ...command, message: '', status: 'unknown',
      })) })
    }).catch(() => { if (active) setObserved(undefined) })
    return () => { active = false }
  }, [key, supported, api, journal, isCurrent, address, run])
  const ready = supported && observed?.key === key && isCurrent()
  return {
    ready,
    commandEpoch: ready ? observed.epoch : undefined,
    commandHistory: ready ? observed.history : undefined,
    onCommandIntent: (command: SubagentCommand) => { current(); journal!.remember(command) },
    onCommandUpdate: (command: SubagentCommand) => { current(); journal!.update(command) },
    onSteer: async (id: string, message: string, clientMessageId: string, continuation = false) => {
      current()
      if (!ready || id !== run.agentId || !api?.steerRuntimeSubagent) throw new Error('Exact member control unavailable')
      const result = await api.steerRuntimeSubagent({ address: { ...address }, agentId: id,
        message, clientMessageId, expectedBackgroundRun: { ...run },
        ...(continuation ? { continueOriginalRun: true } : {}) })
      current()
      if (result.agentId !== id || result.clientMessageId !== clientMessageId || !same(result.expectedBackgroundRun))
        throw new Error('Exact member command result unavailable')
      return result
    },
    onLookupCommand: async (id: string, clientMessageId: string) => {
      current()
      if (id !== run.agentId || !api?.readRuntimeSubagentCommand) throw new Error('Exact member control unavailable')
      const value = await api.readRuntimeSubagentCommand({ address: { ...address }, agentId: id,
        clientMessageId, expectedBackgroundRun: { ...run } })
      current()
      if (value.threadId !== run.parentSessionId || value.agentId !== id || value.clientMessageId !== clientMessageId
        || (value.receipt && !same(value.receipt.backgroundRun))) throw new Error('Exact member receipt unavailable')
      return value.receipt ? { ...receiptAsSteer(value.receipt), agentId: id, expectedBackgroundRun: { ...run } } : null
    },
    onStop: async (id: string) => {
      current()
      if (id !== run.agentId || !api?.stopRuntimeSubagent) throw new Error('Exact member stop unavailable')
      const value = await api.stopRuntimeSubagent({ address: { ...address }, agentId: id, expectedBackgroundRun: { ...run } })
      current()
      if (!same(value.expectedBackgroundRun)) throw new Error('Exact member stop result unavailable')
      return value
    },
  }
}
