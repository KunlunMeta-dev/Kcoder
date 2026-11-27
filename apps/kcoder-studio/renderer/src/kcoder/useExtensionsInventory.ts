import { notifyToolsCatalogChanged } from './toolsCatalogEvents'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createExtensionsApi,
  extensionsFailureKind,
  mergeBinaryResult,
  pluginSkillSwitch,
  type ExtensionSkillPreference,
  type ExtensionsApi,
  type ExtensionsFailureKind,
  type ExtensionsInventoryResult,
  type ExtensionsTarget,
} from './extensionsInventory'

export type ExtensionsInventoryStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'

export interface ExtensionsNotice {
  kind: 'saved' | ExtensionsFailureKind
}

export interface ExtensionsInventoryState {
  status: ExtensionsInventoryStatus
  result: ExtensionsInventoryResult | null
  error: ExtensionsFailureKind | null
  /** Outcome of the latest preference write or binary check. */
  notice: ExtensionsNotice | null
  saving: boolean
  checkingBinaries: boolean
  refresh(): Promise<void>
  /** Explicit user action only: probes command-line tools on the target PATH. */
  checkBinaries(): Promise<void>
  updatePreference(next: ExtensionSkillPreference): Promise<void>
  /** Turns one installed plugin's skills on or off against the observed revision. */
  setPluginSkillsEnabled(pluginId: string, enabled: boolean): Promise<void>
  dismissNotice(): void
}

/**
 * Target-scoped extension inventory; mount one per target scope. Refreshes never probe binaries; the last
 * explicit binary check stays visible until the scope changes. Preference
 * writes carry the observed revision and are never retried automatically.
 */
export function useExtensionsInventory(
  target: ExtensionsTarget & { enabled: boolean },
  api?: ExtensionsApi
): ExtensionsInventoryState {
  const { enabled, deviceId, workspacePath, isScopeCurrent } = target
  const client = useMemo(
    () => api ?? createExtensionsApi({ deviceId, workspacePath, isScopeCurrent }),
    [api, deviceId, workspacePath, isScopeCurrent]
  )
  const [status, setStatus] = useState<ExtensionsInventoryStatus>(enabled ? 'loading' : 'idle')
  const [result, setResult] = useState<ExtensionsInventoryResult | null>(null)
  const [error, setError] = useState<ExtensionsFailureKind | null>(null)
  const [notice, setNotice] = useState<ExtensionsNotice | null>(null)
  const [saving, setSaving] = useState(false)
  const [checkingBinaries, setCheckingBinaries] = useState(false)
  const generation = useRef(0)
  const owner = useRef(client)
  const binaries = useRef<ExtensionsInventoryResult | null>(null)
  const revision = useRef<string | null>(null)
  const latest = useRef<ExtensionsInventoryResult | null>(null)
  useEffect(() => {
    owner.current = client
  }, [client])

  const load = useCallback(
    async (includeBinaries: boolean) => {
      const ticket = ++generation.current
      const current = () => generation.current === ticket && owner.current === client
      try {
        const next = await client.inventory(includeBinaries ? { includeBinaries: true } : {})
        if (!current()) return false
        if (next.binariesIncluded) binaries.current = next
        const merged = mergeBinaryResult(next, binaries.current)
        revision.current = merged.skillPreferenceRevision
        latest.current = merged
        setResult(merged)
        setError(null)
        setStatus('ready')
        return true
      } catch (value) {
        if (!current()) return false
        const kind = extensionsFailureKind(value)
        // Keep the last authoritative projection visible during a failed refresh.
        if (kind !== 'unsupported' && revision.current !== null) {
          setNotice({ kind })
          return false
        }
        setResult(null)
        setError(kind)
        setStatus(kind === 'unsupported' ? 'unsupported' : 'error')
        revision.current = null
        latest.current = null
        return false
      }
    },
    [client]
  )

  const refresh = useCallback(async () => {
    if (!enabled) return
    setStatus(previous => (previous === 'ready' ? previous : 'loading'))
    await load(false)
  }, [enabled, load])

  // Owners remount this hook per target scope (see usePluginTargetScope), so
  // only the generation fence is needed to drop late results.
  useEffect(() => {
    if (!enabled) return
    void load(false)
    return () => {
      generation.current += 1
    }
  }, [enabled, load])

  const checkBinaries = useCallback(async () => {
    if (!enabled) return
    const scope = client
    setCheckingBinaries(true)
    setNotice(null)
    try {
      await load(true)
    } finally {
      if (owner.current === scope) setCheckingBinaries(false)
    }
  }, [client, enabled, load])

  const updatePreference = useCallback(
    async (next: ExtensionSkillPreference) => {
      const expected = revision.current
      if (!enabled || expected === null) return
      const scope = client
      setSaving(true)
      setNotice(null)
      try {
        const receipt = await client.updateSkillPreference(expected, next)
        if (owner.current !== scope) return
        revision.current = receipt.revision
        setResult(previous =>
          previous
            ? {
                ...previous,
                skillPreference: receipt.preference,
                skillPreferenceRevision: receipt.revision,
              }
            : previous
        )
        setNotice({ kind: 'saved' })
        notifyToolsCatalogChanged(deviceId)
      } catch (value) {
        if (owner.current !== scope) return
        // Conflicts and unknown outcomes reload the authoritative state; the
        // user decides again instead of the write being replayed.
        setNotice({ kind: extensionsFailureKind(value, true) })
      } finally {
        if (owner.current === scope) setSaving(false)
      }
      if (owner.current === scope) await load(false)
    },
    [client, deviceId, enabled, load]
  )

  const setPluginSkillsEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const observed = pluginSkillSwitch(latest.current, pluginId)
      if (!observed || observed.enabled === enabled) return
      const scope = client
      setSaving(true)
      setNotice(null)
      try {
        await client.setPluginSkillsEnabled(pluginId, enabled, observed.revision)
        if (owner.current !== scope) return
        setNotice({ kind: 'saved' })
        notifyToolsCatalogChanged(deviceId)
      } catch (value) {
        if (owner.current !== scope) return
        // Like preference writes: reload the authoritative state and let the
        // user decide again; the switch is never replayed automatically.
        setNotice({ kind: extensionsFailureKind(value, true) })
      } finally {
        if (owner.current === scope) setSaving(false)
      }
      // Skill copies, conflicts and the new revision come from the target.
      if (owner.current === scope) await load(false)
    },
    [client, deviceId, load]
  )

  return {
    status,
    result,
    error,
    notice,
    saving,
    checkingBinaries,
    refresh,
    checkBinaries,
    updatePreference,
    setPluginSkillsEnabled,
    dismissNotice: useCallback(() => setNotice(null), []),
  }
}
