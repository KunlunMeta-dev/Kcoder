import { useEffect, useSyncExternalStore } from 'react'
import './conversation-fonts.css'
import licenseUrl from '../../../../shared/assets/fonts/noto-sans-sc/OFL.txt?url'

export const conversationFontLicenseUrl = licenseUrl
export const conversationFontStack = '"KCoder Noto Sans SC", var(--font-ui), sans-serif'
type FontStatus = 'idle' | 'loading' | 'ready' | 'error'
let status: FontStatus = 'idle'
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
function publish(next: FontStatus) {
  status = next
  listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getSnapshot = () => status
const getIdleSnapshot = (): FontStatus => 'idle'
const subscribeIdle = () => () => {}

// Local font loading is optional and never gates app startup or target connectivity.
export function loadConversationFonts(): Promise<void> {
  if (loading) return loading
  if (typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve()
  publish('loading')
  loading = Promise.all([
    document.fonts.load('400 17px "KCoder Noto Sans SC"'),
    document.fonts.load('700 17px "KCoder Noto Sans SC"'),
  ]).then(results => publish(results.every(fonts => fonts.length > 0) ? 'ready' : 'error'))
    .catch(() => publish('error'))
  return loading
}

export function useConversationFontStatus(enabled: boolean): FontStatus {
  const current = useSyncExternalStore(enabled ? subscribe : subscribeIdle, enabled ? getSnapshot : getIdleSnapshot, getIdleSnapshot)
  useEffect(() => { if (enabled) void loadConversationFonts() }, [enabled])
  return current
}
