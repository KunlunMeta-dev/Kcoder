/** Native process proof is rechecked for each connection; history cannot enable scripts. */
export async function nativeIsolatedWidgetsAvailable(): Promise<boolean> {
  const host = (
    window as Window & {
      kcoderDesktopHost?: {
        widgets?: { getCapabilities?: () => Promise<{ isolatedHtml?: boolean }> }
      }
    }
  ).kcoderDesktopHost?.widgets
  if (typeof host?.getCapabilities !== 'function') return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      host.getCapabilities(),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), 1500)
      }),
    ])
    return result?.isolatedHtml === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The Apps dispatcher needs all native lease operations, not merely an Electron name. */
export function nativeMcpAppBridgeAvailable(): boolean {
  const bridge = (window as Window & { kcoderDesktopHost?: { widgets?: Record<string, unknown> } })
    .kcoderDesktopHost?.widgets
  return Boolean(
    bridge &&
    ['getCapabilities', 'authorize', 'heartbeat', 'revoke', 'onRevoked'].every(
      method => typeof bridge[method] === 'function'
    )
  )
}
