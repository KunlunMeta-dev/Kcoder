import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getRuntimeConfig } from '@/config/runtime'
import { listenAccountContextChanges } from './accountContextEvents'
import { fetchGatewayServers, type GatewayServer } from './gatewayRpc'
import { hookTargetScope } from './gatewayHookConfiguration'

class PluginScopeLifetime {
  private active = true
  readonly key: string
  constructor(key: string) {
    this.key = key
  }
  isCurrent = () => this.active
  activate() {
    this.active = true
  }
  invalidate() {
    this.active = false
  }
}

function createTargetObservation(deviceId: string | undefined, basePath: string, initialFingerprint?: string) {
  const listeners = new Set<() => void>()
  let fingerprint = initialFingerprint
  let readController: AbortController | undefined
  let queuedChange: boolean | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
  const read = async (changed: boolean) => {
    if (!deviceId || listeners.size === 0) return
    const controller = new AbortController()
    readController = controller
    try {
      const servers = await fetchGatewayServers(fetch, { signal: controller.signal })
      if (listeners.size === 0 || controller.signal.aborted || getRuntimeConfig().appBasePath !== basePath) return
      const target = servers.find(item => item.id === deviceId)
      const next = target ? hookTargetScope(target) : ''
      const different = fingerprint === undefined || next !== fingerprint
      fingerprint = next
      if (changed && different) notify()
    } catch {
      /* RPC scope checks still reject an unavailable or changed target. */
    } finally {
      if (readController === controller) readController = undefined
    }
  }
  const schedule = (changed: boolean) => {
    readController?.abort()
    if (queuedChange !== undefined) { queuedChange ||= changed; return }
    queuedChange = changed
    // Wait for every account/configuration listener to retire the old HTTP read.
    queueMicrotask(() => {
      const changed = queuedChange === true
      queuedChange = undefined
      if (listeners.size > 0) void read(changed)
    })
  }
  const changed = (event: Event) => {
    const targetId = (event as CustomEvent<{ targetId?: string }>).detail?.targetId
    if (deviceId && (!targetId || targetId === deviceId)) schedule(true)
  }
  const stopAccount = listenAccountContextChanges(targetId => {
    if (deviceId && deviceId !== targetId) return
    fingerprint = undefined
    schedule(false)
    notify()
  })
  window.addEventListener('kcoder:servers-changed', changed)
  return { listeners, ensureBaseline: () => {
    if (fingerprint === undefined && !readController && queuedChange === undefined) void read(false)
  }, stop: () => {
    readController?.abort()
    stopAccount()
    window.removeEventListener('kcoder:servers-changed', changed)
  } }
}

// Only live UI observations share a fingerprint; no directory DTO or authorization is cached.
const targetObservations = new Map<string, ReturnType<typeof createTargetObservation>>()

/** UI lifetime; initialTarget comes from the caller's current directory read, never an authorization verdict. */
export function usePluginTargetScope(deviceId?: string, workspacePath?: string, initialTarget?: GatewayServer | null) {
  const [revision, setRevision] = useState(0)
  const basePath = getRuntimeConfig().appBasePath
  const initialFingerprint = initialTarget && initialTarget.id === deviceId ? hookTargetScope(initialTarget) : undefined
  const observationKey = JSON.stringify([basePath, deviceId ?? null])
  const identity = initialFingerprint === undefined ? revision : [revision, initialFingerprint]
  const key = JSON.stringify([basePath, deviceId ?? null, workspacePath ?? null, identity])
  const lifetime = useMemo(() => new PluginScopeLifetime(key), [key])
  const owner = useRef(lifetime)
  useLayoutEffect(() => {
    owner.current = lifetime
    lifetime.activate()
    return () => lifetime.invalidate()
  }, [lifetime])
  useLayoutEffect(() => {
    const observation = targetObservations.get(observationKey) ?? createTargetObservation(deviceId, basePath, initialFingerprint)
    targetObservations.set(observationKey, observation)
    const invalidate = () => {
      owner.current.invalidate()
      setRevision(value => value + 1)
    }
    observation.listeners.add(invalidate)
    observation.ensureBaseline()
    return () => {
      observation.listeners.delete(invalidate)
      if (observation.listeners.size === 0) {
        targetObservations.delete(observationKey)
        observation.stop()
      }
    }
  }, [observationKey, deviceId, basePath, initialFingerprint])
  return { key, isCurrent: lifetime.isCurrent }
}
