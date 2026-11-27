import { desktopHost } from './desktopHost'
import { isKCoderGatewayPage } from './gatewayRpc'
import {
  isCloudDevice,
  isKCoderLocalGatewayDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import { openNativeProjectDirectoryPickers } from '@/lib/native-directory-picker'
import type { DeviceInfo } from '@/types/api'

export function canPickDesktopProjectDirectories(device: DeviceInfo): boolean {
  return (
    typeof desktopHost()?.pickWorkspacePaths === 'function' && isKCoderLocalGatewayDevice(device)
  )
}

export function canUseNativeProjectPickerForDevice(
  device: DeviceInfo,
  legacyPickerAvailable: boolean
): boolean {
  if (isKCoderGatewayPage() || isKCoderLocalGatewayDevice(device))
    return canPickDesktopProjectDirectories(device)
  return legacyPickerAvailable && !isCloudDevice(device) && !isRemoteDevice(device)
}

export async function pickProjectDirectoriesForDevice(
  device: DeviceInfo,
  initialDirectory?: string
): Promise<string[]> {
  if (canPickDesktopProjectDirectories(device)) {
    return desktopHost()!.pickWorkspacePaths!({
      serverId: device.device_id,
      initialDirectory: initialDirectory || null,
      multiple: true,
    })
  }
  if (
    isKCoderGatewayPage() ||
    isKCoderLocalGatewayDevice(device) ||
    isCloudDevice(device) ||
    isRemoteDevice(device)
  ) {
    throw new Error('This target requires server-side directory browsing')
  }
  return openNativeProjectDirectoryPickers(initialDirectory)
}
