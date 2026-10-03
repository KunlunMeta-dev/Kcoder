import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'

export function isCloudConnectionUiAvailable(): boolean {
  return isLocalFirstAppRuntime() && !isKCoderGatewayPage()
}
