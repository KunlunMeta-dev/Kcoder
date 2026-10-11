import { installDesktopHostNavigation, syncDesktopPreferences } from './desktopHost'
import { createGatewayPageIpcHandler } from './gateway/install/ipc'
import { readPreferences } from './gateway/install/preferences'
import { InstalledGatewayRuntime as KCoderGatewayRuntime } from './gateway/install/runtime'
import { gatewayToken, safeGatewayFailureDiagnostic } from './gatewayRpc'
import {
  installGatewayIpc,
  installGatewayRuntimeLifecycle,
  type GatewayRuntimeLifecycleDependencies,
} from './gatewayRuntimeInstall'
import { registerGatewayWorkspaceSessionRuntime } from './gatewayServiceBridge'
export { readGatewayRuntimeConfig, updateGatewayRuntimeConfig } from './gateway/install/preferences'
export { InstalledGatewayRuntime as KCoderGatewayRuntime } from './gateway/install/runtime'
export { rawDeltaText } from './gatewayRuntime'
export type { KCoderGatewayRuntimeOptions } from './gatewayRuntime'

export function installGatewayPageRuntime(
  overrides: Partial<GatewayRuntimeLifecycleDependencies<KCoderGatewayRuntime>> = {}
) {
  const installation = installGatewayRuntimeLifecycle({
    readToken: () => (typeof document === 'undefined' ? null : gatewayToken()),
    createRuntime: token => new KCoderGatewayRuntime(token),
    createIpcHandler: createGatewayPageIpcHandler,
    installIpc: installGatewayIpc,
    installNavigation: installDesktopHostNavigation,
    registerWorkspaceRuntime: registerGatewayWorkspaceSessionRuntime,
    addBeforeUnload: listener => addEventListener('beforeunload', listener, { once: true }),
    removeBeforeUnload: listener => removeEventListener('beforeunload', listener),
    ...overrides,
  })
  if (installation)
    void syncDesktopPreferences(readPreferences()).catch(error => {
      console.error(
        'Failed to synchronize desktop preferences',
        safeGatewayFailureDiagnostic(error)
      )
    })
  return installation
}

installGatewayPageRuntime()
