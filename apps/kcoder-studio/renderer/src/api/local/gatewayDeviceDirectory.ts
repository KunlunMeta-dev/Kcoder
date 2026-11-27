import { abortable } from '@/lib/abortable'
import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import type { LocalExecutorStatus } from '@/host/localExecutor'
import { fetchGatewayServers, fetchGatewayServersWithHealth } from '@/kcoder/gatewayRpc'

/** Preflight and metadata are independent; only the completed pair may publish devices. */
export async function readGatewayDeviceDirectory(
  ensure: () => Promise<LocalExecutorStatus>, selectedOnly: boolean, isCurrent?: () => boolean
) {
  const controller = new AbortController()
  const path = joinAppPath(getRuntimeConfig().appBasePath, '/api/servers')
  const cancel = () => controller.abort()
  const stopAccount = listenAccountContextChanges(cancel)
  window.addEventListener('kcoder:servers-changed', cancel)
  try {
    const [status, servers] = await abortable(Promise.all([
      ensure(),
      selectedOnly
        ? fetchGatewayServers(fetch, { signal: controller.signal })
        : fetchGatewayServersWithHealth(fetch, { signal: controller.signal }),
    ]), controller.signal)
    controller.signal.throwIfAborted()
    if (isCurrent?.() === false || path !== joinAppPath(getRuntimeConfig().appBasePath, '/api/servers'))
      throw new DOMException('Gateway target context changed', 'AbortError')
    return { status, servers }
  } finally {
    stopAccount()
    window.removeEventListener('kcoder:servers-changed', cancel)
    // Release only this read's HTTP waiter, including preflight failure/cancellation.
    controller.abort()
  }
}
