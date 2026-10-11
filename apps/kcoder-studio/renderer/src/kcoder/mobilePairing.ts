import { getRuntimeConfig } from '@/config/runtime'

export interface MobilePairingDevice {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number
  expiresAt: number
}

export interface MobilePairingSettings {
  token: string
  expiresAt: number
  devices: MobilePairingDevice[]
  publicBaseUrl?: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getRuntimeConfig().apiBaseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...(init?.headers ?? {}), 'content-type': 'application/json' },
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: unknown }
    const message =
      typeof payload.error === 'string' ? payload.error : `Gateway 请求失败（${response.status}）`
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function fetchMobilePairingSettings(): Promise<MobilePairingSettings> {
  return request('/mobile/pairing')
}

export function rotateMobilePairingCredential(): Promise<Omit<MobilePairingSettings, 'devices'>> {
  return request('/mobile/pairing', { method: 'POST', body: '{}' })
}

export function revokeMobilePairingDevice(deviceId: string): Promise<void> {
  return request(`/mobile/pairing/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    body: '{}',
  })
}
