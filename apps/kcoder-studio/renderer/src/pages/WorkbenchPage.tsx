import { ExpertConversationShell } from '@/features/experts/ExpertConversationShell'
import {
  DeferredWorkbenchPage,
  DeferredExpertsPage as ExpertsPage,
  DeferredChannelsPage as ChannelsPage,
  DeferredPersonalizationPage as PersonalizationPage,
  DeferredScheduledTasks as ScheduledTasksPanel,
  DeferredTaskWorkspace as TaskWorkspacePage,
  DeferredMemoryWorkspace as MemoryWorkspace,
  DeferredKnowledgeWorkspace as KnowledgeWorkspace,
  DeferredWorkflowWorkspace as WorkflowWorkspace,
} from '@/components/layout/DeferredWorkbenchPage'
import { useTranslation } from '@/hooks/useTranslation'
import { useSettingsLayout } from '@/hooks/useSettingsLayout'
import { isSettingsRoute, toBrowserPath, navigateTo } from '@/lib/navigation'
import { stripAppBasePath } from '@/config/runtime'
import { useEffect, useMemo, useState } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { currentHostDeviceId } from '@/features/runtime-target/currentHostTarget'
import { useIsMobile } from '@/hooks/useIsMobile'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { buildTrayMenuTaskGroups } from '@/host/trayMenuState'
import { syncTrayMenuState } from '@/host/trayNavigation'
import { useRuntimeTaskRouteRestoration } from '@/features/workbench/useRuntimeTaskRouteRestoration'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
export function WorkbenchPage() {
  const { t } = useTranslation('common')
  const isMobileViewport = useIsMobile()
  const [featurePath, setFeaturePath] = useState(() => stripAppBasePath(window.location.pathname))
  const workflowOpen = featurePath === '/workflows'
  const knowledgeOpen = featurePath === '/knowledge'
  const contextOpen = featurePath === '/context'
  const taskSpaceOpen = featurePath === '/tasks'
  const automationsOpen = featurePath === '/automations'
  const memoryOpen = featurePath === '/memory' || contextOpen
  useEffect(() => {
    const update = () => {
      const path = stripAppBasePath(window.location.pathname)
      if (path === '/office' || path === '/connections') {
        window.history.replaceState({}, '', toBrowserPath('/'))
        setFeaturePath('/')
      } else setFeaturePath(path)
    }
    update()
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
    isMobileViewport,
    settingsOpen
  )
  const { state, runtimeTaskReminders, openRuntimeTask } = useWorkbench()
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

  return (
    <DeferredWorkbenchPage>
      {mobileLayout ? (
        featurePath === '/expert-conversations' ? (
          <ExpertConversationShell active>
            <MobileWorkbenchLayout />
          </ExpertConversationShell>
        ) : featurePath === '/experts' ? (
          <ExpertsPage />
        ) : featurePath === '/personalization' || featurePath.startsWith('/personalization/') ? (
          <PersonalizationPage />
        ) : featurePath === '/channels' ? (
          <ChannelsPage />
        ) : automationsOpen ? (
          <ScheduledTasksPanel
            runtimeWork={state.runtimeWork}
            currentHostId={currentHostDeviceId(state.devices)}
            onOpenTask={async address => {
              navigateTo('/')
              await openRuntimeTask(address)
            }}
          />
        ) : taskSpaceOpen ? (
          <TaskWorkspacePage />
        ) : memoryOpen ? (
          <MemoryWorkspace includeKnowledge={contextOpen} />
        ) : knowledgeOpen ? (
          <KnowledgeWorkspace />
        ) : workflowOpen ? (
          <WorkflowWorkspace />
        ) : (
          <MobileWorkbenchLayout />
        )
      ) : (
        <DesktopWorkbenchLayout />
      )}
    </DeferredWorkbenchPage>
  )
}
