import { useCallback, useEffect, useRef, useState } from 'react'
import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'
import { migrationSourceRecoveryScope } from './migrationSourceTransferScope'
import type { GatewayServer } from './gatewayRpc'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { createMigrationSourceTransferClient } from './gatewayMigrationSourceTransfers'
import { createMigrationSourceTransferRecovery } from './migrationSourceTransferRecovery'
import type { MigrationSourceSelectionV1, MigrationSourceSessionParams, MigrationSourceTransferResult, MigrationSourceTransferRunParams } from '../../../shared/generated/contracts'

interface Operation {
  input: MigrationSourceTransferRunParams
  cancelId: string
  recovery: ReturnType<typeof createMigrationSourceTransferRecovery>
  transfers: ReturnType<typeof createMigrationSourceTransferClient>
  sessions: ReturnType<typeof createMigrationSourceSessionClient>
}

/** One confirmed transfer per source session; rediscovery creates a fresh source owner. */
export function useMigrationSourceTransfer(target: GatewayServer, isCurrent: () => boolean) {
  const [result, setResult] = useState<MigrationSourceTransferResult | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef<Operation | null>(null)
  const active = useRef(false)
  const flight = useRef(false)
  const visible = useCallback(() => active.current && isCurrent(), [isCurrent])
  const release = useCallback(async (owned: Operation) => {
    try { await owned.sessions.close(owned.input.target) } catch {
      // Gateway retains ownership if cleanup cannot be confirmed.
    }
  }, [])
  useEffect(() => {
    active.current = true
    return () => { active.current = false; if (operation.current) void release(operation.current) }
  }, [release])
  const perform = useCallback(async (action: (owned: Operation) => Promise<MigrationSourceTransferResult>) => {
    const owned = operation.current
    if (!owned || flight.current || !visible()) return
    flight.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await action(owned)
      if (visible() && operation.current === owned) setResult(next)
    } catch (failure) {
      if (visible()) setError(failure instanceof MigrationSourceHttpError ? failure.code : 'source_transfer_outcome_unknown')
    } finally {
      flight.current = false
      if (visible()) setBusy(false)
      else await release(owned)
    }
  }, [release, visible])
  const start = useCallback(async (source: MigrationSourceSessionParams, selections: MigrationSourceSelectionV1[]) => {
    if (operation.current || flight.current || !visible() || !selections.length) return
    const id = createRandomUuid()
    const accountCurrent = captureAccountContextRevision()
    const cleanupScope = () => accountCurrent(target.id) ? id : ''
    const scope = () => visible() && accountCurrent(source.targetId) && accountCurrent(target.id) ? id : ''
    try {
      const recovery = createMigrationSourceTransferRecovery({ storage: localStorage, captureScope: scope,
        recoveryScope: migrationSourceRecoveryScope(target) })
      const input: MigrationSourceTransferRunParams = { requestId: id, attemptId: createRandomUuid(), source: structuredClone(source),
        target: { sessionId: createRandomUuid(), purpose: 'target', targetId: target.id,
          ...(target.workspacePath === undefined ? {} : { workspacePath: target.workspacePath }) },
        selections: structuredClone(selections) }
      operation.current = { input, cancelId: createRandomUuid(), recovery,
        transfers: createMigrationSourceTransferClient({ captureScope: scope }),
        sessions: createMigrationSourceSessionClient({ captureScope: cleanupScope }) }
      setRequestId(id)
      await perform(async owned => {
        const opened = await owned.sessions.open(owned.input.target)
        if (!visible()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
        if (opened.status !== 'ready') throw new MigrationSourceHttpError('source_transfer_target_not_ready', false)
        return owned.recovery.start(owned.input)
      })
    } catch (failure) {
      if (visible()) setError(failure instanceof MigrationSourceHttpError ? failure.code : 'source_transfer_recovery_unavailable')
    }
  }, [perform, target, visible])
  const refresh = useCallback(() => perform(owned => owned.recovery.reconcile(owned.input.requestId)), [perform])
  const retry = useCallback(() => perform(async owned => {
    // A durable locator means a request may have been sent: reconcile only.
    if (owned.recovery.load(owned.input.requestId)) return owned.recovery.reconcile(owned.input.requestId)
    const opened = await owned.sessions.open(owned.input.target)
    if (!visible()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
    if (opened.status !== 'ready') throw new MigrationSourceHttpError('source_transfer_target_not_ready', false)
    return owned.recovery.start(owned.input)
  }), [perform, visible])
  const cancel = useCallback(() => perform(owned => owned.transfers.cancel({ requestId: owned.input.requestId,
    source: owned.input.source, target: owned.input.target, commandId: owned.cancelId })), [perform])
  useEffect(() => {
    if (!result || result.coordinatorState !== 'running' || busy || error) return
    const timer = setTimeout(() => { void refresh() }, 1000)
    return () => clearTimeout(timer)
  }, [result, busy, error, refresh])
  return { result, requestId, busy, error, start, refresh, retry, cancel }
}
