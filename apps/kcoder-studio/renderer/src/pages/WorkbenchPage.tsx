import { useTranslation } from '@/hooks/useTranslation'
import { toBrowserPath } from '@/lib/navigation'
import { stripAppBasePath } from '@/config/runtime'
import { useEffect, useMemo } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { buildTrayMenuTaskGroups } from '@/host/trayMenuState'
import { syncTrayMenuState } from '@/host/trayNavigation'
import { useRuntimeTaskRouteRestoration } from '@/features/workbench/useRuntimeTaskRouteRestoration'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { desktopHost } from '@/kcoder/desktopHost'
export function WorkbenchPage() {
  useEffect(() => {
    const redirectRetiredRoute = () => {
      const path = stripAppBasePath(window.location.pathname)
      if (path === '/office' || path === '/connections') window.history.replaceState({}, '', toBrowserPath('/'))
    }
    redirectRetiredRoute()
    window.addEventListener('popstate', redirectRetiredRoute)
    return () => window.removeEventListener('popstate', redirectRetiredRoute)
  }, [])
  useRuntimeTaskRouteRestoration()

  return (
    <>
      {desktopHost() && <WorkbenchTrayMenu />}
      <DesktopWorkbenchLayout />
    </>
  )
}

/** Only a native host consumes the global task projection for its tray. */
function WorkbenchTrayMenu() {
  const { t } = useTranslation('common')
  const { state, runtimeTaskReminders } = useWorkbench()
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const { trayUnreadEnabled, trayRunningEnabled } = taskReminders.preferences
  const trayMenuTaskGroups = useMemo(
    () =>
      buildTrayMenuTaskGroups(state.runtimeWork, {
        reminders: taskReminders,
        lifecycle,
        showUnread: trayUnreadEnabled,
        showRunning: trayRunningEnabled,
      }),
    [lifecycle, state.runtimeWork, taskReminders, trayUnreadEnabled, trayRunningEnabled]
  )
  const trayTooltip = useMemo(() => {
    const parts = []
    if (trayMenuTaskGroups.hasRunningTasks) {
      parts.push(t('workbench.tray_tasks_running'))
    }
    if (trayUnreadEnabled && taskReminders.unreadCount > 0) {
      parts.push(t('workbench.tray_unread_completed', { count: taskReminders.unreadCount }))
    }
    return parts.length > 0 ? parts.join('\n') : null
  }, [t, taskReminders.unreadCount, trayMenuTaskGroups.hasRunningTasks, trayUnreadEnabled])

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups, undefined, {
      title: null,
      tooltip: trayTooltip,
    })
  }, [trayMenuTaskGroups, trayTooltip])

  return null
}
