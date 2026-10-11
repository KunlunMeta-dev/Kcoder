import { installedCompatibility } from '../runtime/compatibility'
import type { KCoderGatewayRuntimeOptions } from '../runtime/contracts'
import { GatewayRuntimeCore } from '../runtime/core'

/** Production adapter preserves the installed page's historical ABI policy. */
export class InstalledGatewayRuntime extends GatewayRuntimeCore {
  constructor(token: string, options: KCoderGatewayRuntimeOptions = {}) {
    super(token, options, installedCompatibility)
  }
}
