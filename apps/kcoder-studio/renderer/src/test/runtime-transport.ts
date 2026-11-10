import { registerRuntimeTransport, type RuntimeCommandHandler } from '@/lib/runtime-transport'
import { afterEach } from 'vitest'

const cleanups: Array<() => void> = []

export function installTestTransport(handler: RuntimeCommandHandler): void {
  cleanups.push(registerRuntimeTransport(handler))
}

export function clearTestTransports(): void {
  while (cleanups.length) cleanups.pop()?.()
}

export function installTestDesktopHost(): void {
  installTestTransport(() => null)
  const host = {
    setPreferences: async () => null,
    setTrayState: async () => null,
    setTaskActivity: async () => {},
    hideToTray: async () => {},
    windowAction: async () => null,
    onSettings: () => () => {},
  }
  const previous = Object.getOwnPropertyDescriptor(window, 'kcoderDesktopHost')
  Object.defineProperty(window, 'kcoderDesktopHost', { configurable: true, value: host })
  cleanups.push(() => {
    if ((window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost !== host) return
    if (previous) Object.defineProperty(window, 'kcoderDesktopHost', previous)
    else Reflect.deleteProperty(window, 'kcoderDesktopHost')
  })
}

afterEach(clearTestTransports)
