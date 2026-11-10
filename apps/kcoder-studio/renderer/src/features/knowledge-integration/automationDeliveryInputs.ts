import type {
  ConnectivityConnection,
  MessagingPlatform,
} from '../../../../shared/generated/contracts'
import { isConnectivityConnection } from '../../../../shared/generated/contractGuards.mjs'

export interface AutomationDeliveryDestination {
  id: string
  revision: string
  label: string
  platform: MessagingPlatform
  purpose: 'reply' | 'subscription'
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const cursor = (value: unknown) =>
  value == null || (typeof value === 'string' && value.length > 0 && value.length <= 256)
export function isDeliveryConnectionPage(
  value: unknown
): value is { items: ConnectivityConnection[]; nextCursor?: string | null } {
  return (
    object(value) &&
    Array.isArray(value.items) &&
    value.items.length <= 10 &&
    value.items.every(isConnectivityConnection) &&
    cursor(value.nextCursor)
  )
}
export function isDeliveryDestinationPage(
  value: unknown
): value is {
  connectionId: string
  destinations: AutomationDeliveryDestination[]
  destinationNextCursor?: string | null
} {
  return (
    object(value) &&
    typeof value.connectionId === 'string' &&
    Array.isArray(value.destinations) &&
    value.destinations.length <= 10 &&
    value.destinations.every(
      item =>
        object(item) &&
        ['id', 'revision', 'label'].every(
          key => typeof item[key] === 'string' && item[key].length > 0
        ) &&
        ['wecom', 'weixin', 'feishu', 'dingtalk', 'qq', 'github'].includes(String(item.platform)) &&
        ['reply', 'subscription'].includes(String(item.purpose))
    ) &&
    cursor(value.destinationNextCursor)
  )
}
