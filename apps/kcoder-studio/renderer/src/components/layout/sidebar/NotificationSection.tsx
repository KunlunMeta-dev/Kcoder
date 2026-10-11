import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { cn } from '@/lib/utils'
import type { DeviceInfo, RuntimeIMNotificationSettingsResponse } from '@/types/api'
import { Bell, BellOff } from 'lucide-react'
import type { RefObject } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getGlobalImNotificationTitle, getImNotificationSessionLabel } from './sidebarSelectors'

export function GlobalImNotificationBell({
  devices,
  imNotificationSettings,
  menuOpen,
  menuContainerRef,
  onMenuOpenChange,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onOpenSettings,
  onAddCloudDevice,
}: {
  devices: DeviceInfo[]
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  menuOpen: boolean
  // Portal target covering the full-width account area. The bell trigger lives
  // inside a narrow 32px icon group, so the menu must anchor to this wider
  // relative container for `left-4 right-4` to resolve against the sidebar.
  menuContainerRef: RefObject<HTMLDivElement | null>
  onMenuOpenChange: (open: boolean) => void
  onToggleGlobalImNotification?: () => Promise<void> | void
  onOpenGlobalImNotificationSettings?: () => Promise<void> | void
  onOpenSettings: () => void
  onAddCloudDevice: () => void
}) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  // Resolve the portal target from the ref into state. Reading the ref's
  // `.current` during render is disallowed, so we mirror it into state here.
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    setMenuContainer(menuContainerRef.current)
  }, [menuContainerRef])
  const targetLabel = getImNotificationSessionLabel(imNotificationSettings)
  const enabled = Boolean(imNotificationSettings?.global.enabled)
  const connecting = cloud.status === 'connecting'
  const requiresCloudLogin = !cloud.isConnected
  const needsSession = cloud.isConnected && !targetLabel
  const notifying = enabled && cloud.isConnected && Boolean(targetLabel)
  const cloudConnectionError = cloud.status === 'error' || cloud.status === 'expired'
  const cloudConnectionErrorMessage = cloudConnectionError ? cloud.error : null
  const NotificationIcon = notifying ? Bell : BellOff
  const onlineCloudDeviceCount = useMemo(
    () =>
      devices.filter(
        device => (isCloudDevice(device) || isRemoteDevice(device)) && device.status === 'online'
      ).length,
    [devices]
  )
  const title = getGlobalImNotificationTitle(t, imNotificationSettings, cloud.status)
  const primaryActionLabel = requiresCloudLogin
    ? t('workbench.cloud_connection_login', '登录并连接')
    : enabled
      ? t('workbench.away_im_reminder_disable', '关闭提醒')
      : needsSession
        ? t('workbench.away_im_reminder_choose_session', '选择 IM 会话')
        : t('workbench.away_im_reminder_enable', '开启离开电脑提醒')

  const openCloudLogin = () => {
    onMenuOpenChange(false)
    setCloudDialogOpen(true)
  }

  const openSessionSettings = () => {
    onMenuOpenChange(false)
    const openSettings = onOpenGlobalImNotificationSettings ?? onToggleGlobalImNotification
    if (openSettings) {
      void openSettings()
      return
    }
    onOpenSettings()
  }

  const handlePrimaryAction = () => {
    if (connecting) return
    if (requiresCloudLogin) {
      openCloudLogin()
      return
    }
    if (!onToggleGlobalImNotification) {
      onMenuOpenChange(false)
      onOpenSettings()
      return
    }
    if (needsSession) {
      openSessionSettings()
      return
    }
    onMenuOpenChange(false)
    void onToggleGlobalImNotification()
  }

  return (
    <>
      <button
        type="button"
        data-testid="sidebar-global-im-notification-button"
        aria-pressed={notifying}
        disabled={connecting}
        onClick={() => onMenuOpenChange(!menuOpen)}
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-50',
          notifying && 'text-primary hover:text-primary'
        )}
        title={title}
        aria-label={title}
      >
        <NotificationIcon
          data-testid={
            notifying
              ? 'sidebar-global-im-notification-on-icon'
              : 'sidebar-global-im-notification-muted-icon'
          }
          className={cn('h-4 w-4', notifying && 'fill-current')}
        />
        {needsSession && (
          <span
            data-testid="sidebar-global-im-notification-indicator"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-background"
          />
        )}
      </button>

      {menuOpen &&
        menuContainer &&
        createPortal(
          <div
            data-testid="sidebar-global-im-notification-menu"
            className="absolute bottom-[68px] left-4 right-4 z-30 rounded-xl border border-border bg-background p-3 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary',
                  notifying && 'bg-primary/10 text-primary',
                  needsSession && 'bg-amber-400/15 text-amber-600'
                )}
              >
                <NotificationIcon className={cn('h-4 w-4', notifying && 'fill-current')} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-5">
                  {notifying
                    ? t('workbench.away_im_reminder_on', '离开电脑提醒已开启')
                    : t('workbench.away_im_reminder_title', '离开电脑提醒')}
                </div>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.away_im_reminder_description',
                    '所有任务进展会推送到 IM，不会改变任务的 IM 会话归属。'
                  )}
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary">
                  {t('workbench.away_im_reminder_target', '投递到')}
                </span>
                <span className="min-w-0 truncate font-medium text-text-primary">
                  {targetLabel ?? t('workbench.away_im_reminder_no_target', '未选择 IM 会话')}
                </span>
              </div>
              {requiresCloudLogin && (
                <div className="mt-1 text-text-secondary">
                  {t(
                    'workbench.global_im_notifications_requires_cloud_login',
                    '登录云端后可开启离开电脑提醒'
                  )}
                </div>
              )}
              {cloudConnectionErrorMessage && (
                <div
                  data-testid="sidebar-global-im-notification-error"
                  className="mt-1 min-w-0 break-words text-red-500 [overflow-wrap:anywhere]"
                >
                  {cloudConnectionErrorMessage}
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              {cloud.isConnected && onOpenGlobalImNotificationSettings && (
                <button
                  type="button"
                  data-testid="sidebar-global-im-notification-settings-button"
                  onClick={openSessionSettings}
                  className="h-8 rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  {t('workbench.away_im_reminder_change_session', '更换会话')}
                </button>
              )}
              <button
                type="button"
                data-testid="sidebar-global-im-notification-primary-button"
                disabled={connecting}
                onClick={handlePrimaryAction}
                className={cn(
                  'h-8 shrink-0 whitespace-nowrap rounded-md px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-55',
                  enabled
                    ? 'bg-muted text-text-primary hover:bg-muted/80'
                    : 'bg-text-primary text-background hover:bg-text-primary/90'
                )}
              >
                {primaryActionLabel}
              </button>
            </div>
          </div>,
          menuContainer
        )}

      {cloudDialogOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={onlineCloudDeviceCount}
          onClose={() => setCloudDialogOpen(false)}
          onOpenSettings={onOpenSettings}
          onAddDevice={onAddCloudDevice}
        />
      )}
    </>
  )
}
