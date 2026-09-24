import { WorkflowWorkspace } from '@/features/workflows/WorkflowWorkspace'
import { useTranslation } from '@/hooks/useTranslation'
import { useSettingsLayout } from '@/hooks/useSettingsLayout'
import { isSettingsRoute } from '@/lib/navigation'
import { stripAppBasePath } from '@/config/runtime'
import { useEffect, useMemo, useState } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { isNativeTauriHost } from '@/lib/runtime-environment'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { buildTrayMenuTaskGroups } from '@/tauri/trayMenuState'
import { syncTrayMenuState } from '@/tauri/trayNavigation'
import { useRuntimeTaskRouteRestoration } from '@/features/workbench/useRuntimeTaskRouteRestoration'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
export function WorkbenchPage() {
  const { t } = useTranslation('common')
  const isMobileViewport = useIsMobile()
  const isTauri = isNativeTauriHost()
  const [workflowOpen, setWorkflowOpen] = useState(() => stripAppBasePath(window.location.pathname) === '/workflows')
  useEffect(() => {
    const update = () => setWorkflowOpen(stripAppBasePath(window.location.pathname) === '/workflows')
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  useEffect(() => {
    const update = () =>
      setSettingsOpen(isSettingsRoute(stripAppBasePath(window.location.pathname)))
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  const mobileLayout = useSettingsLayout(
    shouldUseMobileWorkbenchLayout({ isMobileViewport, isTauri }),
    settingsOpen
  )
  const { state, runtimeTaskReminders } = useWorkbench()
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  useRuntimeTaskRouteRestoration()
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

  return mobileLayout ? (workflowOpen ? <WorkflowWorkspace /> : <MobileWorkbenchLayout />) : <DesktopWorkbenchLayout />
}
