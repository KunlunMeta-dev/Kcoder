import type { GatewayClient } from './gatewayRuntimeTypes'

export async function assertRemoteBrowserAvailable(client: GatewayClient): Promise<void> {
  if (client.supportsExperimental?.('browserSessions') !== false) return
  if (client.supportsExperimental?.('browserPreflight') === true) {
    const status = await client.request<{ available: boolean; reason?: string | null }>(
      'browser/preflight',
      {}
    )
    // An executable may have been installed since this connection initialized.
    if (status.available === true) return
    if (typeof status.reason === 'string' && status.reason.trim())
      throw new Error(status.reason.slice(0, 2048))
  }
  throw new Error(
    'The target browser is unavailable. Check its browser installation and startup permissions; upgrade the target KCoder for detailed diagnostics.'
  )
}
