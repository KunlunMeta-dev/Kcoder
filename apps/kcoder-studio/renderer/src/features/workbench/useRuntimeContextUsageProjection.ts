import { useCallback, useEffect, useRef, useState } from 'react'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import type { RuntimeContextUsage, RuntimeTaskAddress } from '@/types/api'
import { getRuntimeTaskRouteKey } from './workbenchRuntimeHelpers'

// Providers may report cumulative usage beside every token. Only the composer
// gauge is sampled; subscribers still receive every observation in order.
const USAGE_DISPLAY_INTERVAL_MS = 100

export function useRuntimeContextUsageProjection() {
  const [byTask, setByTask] = useState<Record<string, RuntimeContextUsage>>({})
  const [pending] = useState(() => new Map<string, {
    deviceId: string
    usage: RuntimeContextUsage
    current: (deviceId: string) => boolean
  }>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (!pending.size) return
    const batch = new Map(pending)
    pending.clear()
    setByTask(current => {
      let next = current
      for (const [key, row] of batch) {
        if (!row.current(row.deviceId) || next[key] === row.usage) continue
        if (next === current) next = { ...current }
        next[key] = row.usage
      }
      return next
    })
  }, [pending])
  const record = useCallback((address: RuntimeTaskAddress, usage: RuntimeContextUsage, immediate = false) => {
    if (!mounted.current) return
    const key = getRuntimeTaskRouteKey(address)
    const previous = pending.get(key)
    if (previous?.current(address.deviceId)) previous.usage = usage
    else pending.set(key, { deviceId: address.deviceId, usage, current: captureAccountContextRevision() })
    if (immediate) flush()
    else if (timer.current === undefined) timer.current = setTimeout(flush, USAGE_DISPLAY_INTERVAL_MS)
  }, [flush, pending])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
      timer.current = undefined
      pending.clear()
    }
  }, [pending])
  return { byTask, record, flush }
}
