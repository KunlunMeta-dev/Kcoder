import { useCallback, useEffect, useRef, useState } from 'react'
import {
  evolutionFailureKind,
  readEvolutionSettings,
  readEvolutionStatus,
  saveEvolutionSettings,
} from '@/kcoder/evolution/evolutionApi'
import type {
  EvolutionSettings,
  EvolutionSettingsReadResult,
  EvolutionStatusResult,
} from '@/kcoder/evolution/evolutionContract'
import { subscribeEvolutionChanged } from '@/kcoder/evolution/evolutionEvents'

export type EvolutionSettingsNotice = 'load_failed' | 'conflict' | 'unconfirmed' | 'save_failed' | 'saved'

export interface EvolutionSettingsState {
  snapshot: EvolutionSettingsReadResult | null
  /** Value shown while a write is pending; falls back to the verified snapshot. */
  settings: EvolutionSettings | null
  status: EvolutionStatusResult | null
  statusFailed: boolean
  loading: boolean
  saving: boolean
  notice: EvolutionSettingsNotice | null
  /** A conflict or unknown write outcome blocks further writes until refresh. */
  blocked: boolean
  save(next: EvolutionSettings): Promise<boolean>
  refresh(): Promise<void>
  refreshStatus(): Promise<void>
}

/**
 * Revision-checked settings ownership for one target. Writes are serial,
 * carry the observed revision and are never retried or replayed automatically.
 */
export function useEvolutionSettings(serverId: string, isCurrent: () => boolean): EvolutionSettingsState {
  const [snapshot, setSnapshot] = useState<EvolutionSettingsReadResult | null>(null)
  const [pending, setPending] = useState<EvolutionSettings | null>(null)
  const [status, setStatus] = useState<EvolutionStatusResult | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<EvolutionSettingsNotice | null>(null)
  const generation = useRef(0)
  const statusGeneration = useRef(0)
  const savingRef = useRef(false)
  const snapshotRef = useRef<EvolutionSettingsReadResult | null>(null)
  const active = useRef(true)
  const current = useCallback(() => active.current && isCurrent(), [isCurrent])

  const refreshStatus = useCallback(async () => {
    const ticket = ++statusGeneration.current
    try {
      const next = await readEvolutionStatus(serverId)
      if (!current() || ticket !== statusGeneration.current) return
      setStatus(next)
      setStatusFailed(false)
    } catch {
      if (current() && ticket === statusGeneration.current) setStatusFailed(true)
    }
  }, [current, serverId])

  const refresh = useCallback(async () => {
    if (savingRef.current) return
    const ticket = ++generation.current
    setLoading(true)
    setNotice(null)
    void refreshStatus()
    try {
      const next = await readEvolutionSettings(serverId)
      if (!current() || ticket !== generation.current) return
      snapshotRef.current = next
      setSnapshot(next)
      setPending(null)
    } catch {
      if (current() && ticket === generation.current) setNotice('load_failed')
    } finally {
      if (current() && ticket === generation.current) setLoading(false)
    }
  }, [current, refreshStatus, serverId])

  useEffect(() => {
    active.current = true
    queueMicrotask(() => {
      if (active.current) void refresh()
    })
    return () => {
      active.current = false
      generation.current += 1
      statusGeneration.current += 1
    }
  }, [refresh])

  useEffect(
    () =>
      subscribeEvolutionChanged(event => {
        // Notifications are refetch hints; the settings snapshot keeps its own revision.
        if (event.deviceId === serverId) void refreshStatus()
      }),
    [refreshStatus, serverId]
  )

  useEffect(() => {
    if (notice !== 'saved') return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const save = useCallback(
    async (next: EvolutionSettings) => {
      const base = snapshotRef.current
      if (!base || savingRef.current || notice === 'conflict' || notice === 'unconfirmed') return false
      savingRef.current = true
      const ticket = ++generation.current
      setSaving(true)
      setPending(next)
      setNotice(null)
      try {
        const saved = await saveEvolutionSettings(serverId, next, base.revision)
        if (!current() || ticket !== generation.current) return false
        snapshotRef.current = saved
        setSnapshot(saved)
        setPending(null)
        setNotice('saved')
        void refreshStatus()
        return true
      } catch (error) {
        if (!current() || ticket !== generation.current) return false
        setPending(null)
        const kind = evolutionFailureKind(error, true)
        setNotice(kind === 'conflict' ? 'conflict' : kind === 'unconfirmed' ? 'unconfirmed' : 'save_failed')
        return false
      } finally {
        savingRef.current = false
        if (current() && ticket === generation.current) setSaving(false)
      }
    },
    [current, notice, refreshStatus, serverId]
  )

  return {
    snapshot,
    settings: pending ?? snapshot?.settings ?? null,
    status,
    statusFailed,
    loading,
    saving,
    notice,
    blocked: notice === 'conflict' || notice === 'unconfirmed',
    save,
    refresh,
    refreshStatus,
  }
}
