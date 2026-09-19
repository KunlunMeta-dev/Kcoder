import { useEffect, useMemo } from 'react'
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
  const isMobileViewport = useIsMobile()
  const isTauri = isNativeTauriHost()
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
      parts.push(i18nLabel('running'))
    }
    if (trayUnreadEnabled && taskReminders.unreadCount > 0) {
      parts.push(i18nLabel('unread', taskReminders.unreadCount))
    }
    return parts.length > 0 ? parts.join('\n') : null
  }, [taskReminders.unreadCount, trayMenuTaskGroups.hasRunningTasks, trayUnreadEnabled])

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups, undefined, {
      title: null,
      tooltip: trayTooltip,
    })
  }, [trayMenuTaskGroups, trayTooltip])

  return shouldUseMobileWorkbenchLayout({ isMobileViewport, isTauri }) ? (
    <MobileWorkbenchLayout />
  ) : (
    <DesktopWorkbenchLayout />
  )
}

function i18nLabel(type: 'running' | 'unread', count?: number) {
  const language = navigator.language || ''
  const english = language.toLowerCase().startsWith('en')
  if (type === 'running') return english ? 'Tasks running' : '有任务运行中'
  return english ? `${count ?? 0} unread completed` : `${count ?? 0} 个未读完成任务`
}
