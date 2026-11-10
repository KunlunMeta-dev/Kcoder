import { useCallback, useSyncExternalStore } from 'react'
import { Network } from 'lucide-react'
import feishu from '@/assets/channel-icons/feishu.svg'
import qq from '@/assets/channel-icons/qq.svg'
import weixin from '@/assets/channel-icons/weixin.svg'
import wecom from '@/assets/channel-icons/wecom.svg'
import github from '@/assets/channel-icons/github.svg'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import {
  readTaskChannelIndicator,
  subscribeTaskChannelIndicator,
} from '@/kcoder/taskChannelBindingIndicators'
import type { RuntimeTaskAddress } from '@/types/api'

const icons: Record<string, string> = { feishu, qq, weixin, wecom, github }
const empty = () => null

export function TaskChannelIndicator({
  address,
  enabled,
}: {
  address: RuntimeTaskAddress
  enabled: boolean
}) {
  const { t } = useTranslation('connectivity')
  const thread = runtimeThreadId(address),
    serverId = address.deviceId,
    workspacePath = address.workspacePath
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !thread || !workspacePath) return () => {}
      return subscribeTaskChannelIndicator({ serverId, workspacePath }, thread, listener)
    },
    [enabled, thread, serverId, workspacePath]
  )
  const read = useCallback(
    () =>
      enabled && thread && workspacePath
        ? readTaskChannelIndicator({ serverId, workspacePath }, thread)
        : null,
    [enabled, thread, serverId, workspacePath]
  )
  const binding = useSyncExternalStore(subscribe, read, empty)
  if (!binding) return null
  const label = t('chatTasks.boundIndicator', {
    connection: binding.connectionLabel,
    chat: binding.chatId,
    topic: binding.topicId ? ` / ${binding.topicId}` : '',
  })
  const icon = Object.hasOwn(icons, binding.platform) ? icons[binding.platform] : undefined
  return (
    <span
      data-testid={`runtime-local-task-channel-${address.taskId}`}
      data-platform={binding.platform}
      data-connection-id={binding.connectionId}
      role="img"
      aria-label={label}
      title={label}
      className="mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center align-middle"
    >
      {icon ? (
        <img src={icon} alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
      ) : (
        <Network aria-hidden="true" className="h-4 w-4" />
      )}
    </span>
  )
}
