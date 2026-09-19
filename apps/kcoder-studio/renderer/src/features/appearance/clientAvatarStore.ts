import { useSyncExternalStore } from 'react'
import { isClientImageUrl } from '@/lib/client-image'

const KEY = 'kcoder-studio:kcoder-avatar-v1'
const EVENT = 'kcoder:avatar-changed'
const subscribe = (listener: () => void) => {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}
const snapshot = () => {
  try {
    const value = localStorage.getItem(KEY)
    return isClientImageUrl(value) && value.length <= 64 * 1024 ? value : null
  } catch {
    return null
  }
}

export function useClientAvatar() {
  return useSyncExternalStore(subscribe, snapshot, () => null)
}

export function saveClientAvatar(value: string | null) {
  if (value !== null && (!isClientImageUrl(value) || value.length > 64 * 1024))
    throw new Error('Invalid avatar image')
  if (value === null) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, value)
  window.dispatchEvent(new Event(EVENT))
}
