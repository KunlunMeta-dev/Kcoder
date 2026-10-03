import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

import {
  getDeviceRouteLabel,
  getDeviceRouteTitle,
  getSidebarDeviceStatusLabel,
  type SidebarDeviceState,
} from './sidebarSelectors'

export function ProjectDeviceInlineStatus({
  deviceState,
  testId,
  className,
}: {
  deviceState: SidebarDeviceState
  testId: string
  className?: string
}) {
  const { t } = useTranslation()
  const unavailable = deviceState.status === 'unavailable'
  const label = unavailable
    ? getSidebarDeviceStatusLabel(t, deviceState.status)
    : getDeviceRouteLabel(deviceState)
  const title = unavailable
    ? `${label}：${getDeviceRouteTitle(deviceState)}`
    : getDeviceRouteTitle(deviceState)
  const online = deviceState.status === 'online'

  return (
    <span
      data-testid={testId}
      title={title}
      aria-label={label}
      className={cn(
        'ml-auto flex min-w-0 shrink-0 items-center gap-2 text-sm leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]',
        className
      )}
    >
      <span className="max-w-[96px] truncate">{label}</span>
      <span
        data-testid={`${testId}-dot`}
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          !online && 'bg-[rgb(var(--color-sidebar-text-muted))] opacity-55'
        )}
        style={online ? { backgroundColor: '#1FD660' } : undefined}
      />
    </span>
  )
}
