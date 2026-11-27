import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { requestLocalExecutor } from '@/host/localExecutor'
import type {
  ContinuousWorkControlState,
  ContinuousWorkObservationOutcome,
} from '@/kcoder/gateway/runtime/continuousWorks'

export type WorkControlAction = 'pause' | 'resume' | 'stop'
export type WorkControlReceiptState = ContinuousWorkControlState | 'reconciled'

export interface WorkControlReceipt {
  action: WorkControlAction
  state: WorkControlReceiptState
  requestId: string
}

export interface WorkControlRequest {
  workId: string
  threadId: string
  workspacePath: string
  revision: number
  action: WorkControlAction
}

export interface WorkControlApi {
  /** True only when the target negotiated the mutation capability. */
  enabled: boolean
  receipt: (workId: string) => WorkControlReceipt | undefined
  submit: (request: WorkControlRequest) => Promise<void>
  recheck: (input: {
    workId: string
    workspacePath: string
  }) => Promise<ContinuousWorkObservationOutcome>
}

interface CapabilitySnapshot {
  owner: string
  control: boolean
}

interface ReceiptSnapshot {
  owner: string
  values: Record<string, WorkControlReceipt>
}

const noReceipts: Record<string, WorkControlReceipt> = {}
const requestIdFor = () => {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `control-${Date.now()}-${Math.round(Math.random() * 1e9)}`
}

/**
 * Control receipts are per work and never inferred from a work observation.
 * An unknown outcome disables repeat submission until the user re-reads it.
 * Both snapshots carry their server owner, so switching targets cannot show a
 * receipt or capability from the previous one.
 */
export function useWorkControl(serverId: string): WorkControlApi {
  const [capability, setCapability] = useState<CapabilitySnapshot>()
  const [receipts, setReceipts] = useState<ReceiptSnapshot>()

  useEffect(() => {
    if (!serverId) return
    let active = true
    void requestLocalExecutor<{ control?: boolean }>('runtime.continuousWork.capabilities', {
      deviceId: serverId,
    })
      .then(value => {
        if (!active) return
        setCapability({ owner: serverId, control: value?.control === true })
      })
      .catch(() => {
        if (!active) return
        setCapability({ owner: serverId, control: false })
      })
    return () => {
      active = false
    }
  }, [serverId])

  const enabled = capability?.owner === serverId && capability.control === true
  const values = receipts?.owner === serverId ? receipts.values : noReceipts
  const valuesOwner = useRef(serverId)
  const valuesRef = useRef(values)
  useEffect(() => {
    valuesOwner.current = serverId
    valuesRef.current = values
  }, [serverId, values])

  const publish = useCallback(
    (workId: string, receipt: WorkControlReceipt) => {
      setReceipts(previous => {
        const base = previous?.owner === serverId ? previous.values : {}
        return { owner: serverId, values: { ...base, [workId]: receipt } }
      })
    },
    [serverId]
  )

  const submit = useCallback(
    async ({ workId, threadId, workspacePath, revision, action }: WorkControlRequest) => {
      if (!enabled) return
      // A lost reply is not proof that nothing happened; require a re-read.
      if (valuesOwner.current === serverId && valuesRef.current[workId]?.state === 'unknown') return
      const requestId = requestIdFor()
      publish(workId, { action, state: 'accepted', requestId })
      try {
        const outcome = await requestLocalExecutor<{
          state?: unknown
          workId?: unknown
          requestId?: unknown
        }>('runtime.continuousWork.control', {
          deviceId: serverId,
          workspacePath,
          threadId,
          workId,
          requestId,
          expectedRevision: revision,
          action,
          target: { kind: 'work' },
        })
        const state =
          outcome?.workId === workId && outcome?.requestId === requestId
            ? (outcome.state as WorkControlReceiptState)
            : 'unknown'
        publish(workId, { action, state, requestId })
      } catch {
        publish(workId, { action, state: 'unknown', requestId })
      }
    },
    [enabled, publish, serverId]
  )

  const recheck = useCallback(
    async ({ workId, workspacePath }: { workId: string; workspacePath: string }) => {
      const outcome = await requestLocalExecutor<ContinuousWorkObservationOutcome>(
        'runtime.continuousWork.read',
        { deviceId: serverId, workspacePath, workId }
      )
      const receipt = valuesOwner.current === serverId ? valuesRef.current[workId] : undefined
      if (receipt && (outcome?.status === 'ready' || outcome?.status === 'absent'))
        publish(workId, { ...receipt, state: 'reconciled' })
      return outcome
    },
    [publish, serverId]
  )

  return useMemo(
    () => ({
      enabled,
      receipt: (workId: string) => values[workId],
      submit,
      recheck,
    }),
    [enabled, recheck, submit, values]
  )
}
