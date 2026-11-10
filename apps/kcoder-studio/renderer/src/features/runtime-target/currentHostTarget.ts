import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { DeviceInfo } from '@/types/api'

/** A missing local host never makes a remote target an implicit default. */
export function currentHostServer(targets: readonly GatewayServer[]): GatewayServer | undefined {
  return targets.find(target => target.transport === 'local')
}
export function currentHostDeviceId(
  devices: readonly Pick<DeviceInfo, 'device_id' | 'device_type' | 'nameKey' | 'capabilities'>[]
): string | undefined {
  // Gateway devices deliberately use remote I/O routing, including the Gateway's
  // own host. Its transport capability is the authoritative presentation hint.
  const gatewayLocal = devices.find(device => device.capabilities?.includes('kcoder-gateway-local'))
  if (gatewayLocal) return gatewayLocal.device_id
  return devices.find(
    device =>
      device.device_type === 'local' ||
      (!device.capabilities?.includes('kcoder-gateway') && device.nameKey === 'currentComputer') ||
      (!device.device_type && device.device_id === 'local')
  )?.device_id
}
