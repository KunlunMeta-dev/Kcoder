import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import {
  KCODER_STUDIO_MIN_EXECUTOR_VERSION,
  isDeviceBelowStudioVersion,
  isGoalCapableWorkbenchDevice,
  isStudioCompatibleDevice,
} from '@/lib/device-capabilities'
import { relabelEmbeddedBrowser } from '@/lib/embedded-browser'
import { safeErrorDiagnostic } from '@/lib/error-diagnostics'
import {
  findWorkbenchDevice,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type { WorkbenchMessage } from '@/types/workbench'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type BottomPanelRenderContext } from '../desktopWorkbenchPaneTypes'
import { pendingRequestUserInputPayload } from '../requestUserInputOverlay'
import { type RightWorkspacePanelTab } from '../workspace-panels/RightWorkspacePanel'
import { findSelectedAssistantPlanContent } from './paneSelectors'
import type { usePaneWorkspacePanels } from './usePaneWorkspacePanels'
import { browserMigrationState, createBottomPanelWorkspaceKey } from './workspacePanelPersistence'

export function usePaneWorkspaceResources(context: ReturnType<typeof usePaneWorkspacePanels>) {
  const {
    onTerminalPanePinChange,
    background,
    projectChat,
    t,
    currentRuntimeTask,
    currentProject,
    paneKey,
    initialBlankBrowserMigration,
    paneSession,
    runtimeWork,
    runtimeTaskTitle,
    workspaceProject,
    paneProjectWork,
    devices,
    rightPanelOpen,
    setRightPanelOpen,
    rightPanelView,
    setRightPanelView,
    rightPanelTabs,
    setRightPanelTabs,
    migratedEmbeddedBrowserLabel,
    setMigratedEmbeddedBrowserLabel,
    selectedAssistantPlan,
    bottomPanelOpenByKey,
    setBottomPanelOpenByKey,
    bottomPanelContexts,
    setBottomPanelContexts,
    defaultEmbeddedBrowserLabel,
    embeddedBrowserLabel,
    activeDeviceId,
    effectiveWorkspaceTarget,
    preferLocalWorkspaceTerminal,
  } = context
  useEffect(() => {
    if (currentRuntimeTask || !rightPanelTabs.includes('browser')) {
      if (browserMigrationState.latestBlankBrowserMigration?.sourcePaneKey === paneKey) {
        browserMigrationState.latestBlankBrowserMigration = null
      }
      return
    }

    browserMigrationState.latestBlankBrowserMigration = {
      sourcePaneKey: paneKey,
      browserLabel: embeddedBrowserLabel,
      rightPanelOpen,
      rightPanelView,
      rightPanelTabs,
      createdAt: Date.now(),
    }
  }, [
    currentRuntimeTask,
    embeddedBrowserLabel,
    paneKey,
    rightPanelOpen,
    rightPanelTabs,
    rightPanelView,
  ])

  useEffect(() => {
    if (!initialBlankBrowserMigration || !currentRuntimeTask) return
    if (migratedEmbeddedBrowserLabel !== initialBlankBrowserMigration.browserLabel) return

    let disposed = false
    void relabelEmbeddedBrowser(
      initialBlankBrowserMigration.browserLabel,
      defaultEmbeddedBrowserLabel
    )
      .then(() => {
        if (!disposed) {
          setMigratedEmbeddedBrowserLabel(null)
        }
      })
      .catch(error => {
        console.error('Failed to migrate embedded browser label:', safeErrorDiagnostic(error))
      })

    return () => {
      disposed = true
    }
  }, [
    currentRuntimeTask,
    defaultEmbeddedBrowserLabel,
    initialBlankBrowserMigration,
    migratedEmbeddedBrowserLabel,
    setMigratedEmbeddedBrowserLabel,
  ])

  const bottomPanelWorkspaceKey = createBottomPanelWorkspaceKey({
    currentRuntimeTask,
    workspaceProjectId: workspaceProject?.id,
    workspaceTarget: effectiveWorkspaceTarget,
    executionMode: paneProjectWork.executionMode,
    preferLocalTerminal: preferLocalWorkspaceTerminal,
  })

  const bottomPanelOpen = bottomPanelOpenByKey[bottomPanelWorkspaceKey] ?? false

  const activeBottomPanelContext = useMemo<BottomPanelRenderContext>(
    () => ({
      key: bottomPanelWorkspaceKey,
      currentProject: workspaceProject,
      devices,
      workspaceTarget: effectiveWorkspaceTarget,
      preferLocalTerminal: preferLocalWorkspaceTerminal,
      terminalContextTitle: runtimeTaskTitle,
    }),
    [
      bottomPanelWorkspaceKey,
      devices,
      effectiveWorkspaceTarget,
      preferLocalWorkspaceTerminal,
      runtimeTaskTitle,
      workspaceProject,
    ]
  )

  const rememberActiveBottomPanelContext = useCallback(() => {
    setBottomPanelContexts(current => {
      const existingIndex = current.findIndex(context => context.key === bottomPanelWorkspaceKey)
      if (existingIndex < 0) {
        return [...current, activeBottomPanelContext]
      }
      if (current[existingIndex] === activeBottomPanelContext) {
        return current
      }
      const next = [...current]
      next[existingIndex] = activeBottomPanelContext
      return next
    })
  }, [activeBottomPanelContext, bottomPanelWorkspaceKey, setBottomPanelContexts])

  const setCurrentBottomPanelOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      rememberActiveBottomPanelContext()
      onTerminalPanePinChange(paneKey, 'bottom-panel', true)
      setBottomPanelOpenByKey(current => {
        const currentOpen = current[bottomPanelWorkspaceKey] ?? false
        const nextOpen = typeof next === 'function' ? next(currentOpen) : next
        if (currentOpen === nextOpen) return current
        return { ...current, [bottomPanelWorkspaceKey]: nextOpen }
      })
    },
    [
      bottomPanelWorkspaceKey,
      onTerminalPanePinChange,
      paneKey,
      rememberActiveBottomPanelContext,
      setBottomPanelOpenByKey,
    ]
  )

  const bottomPanelContextsToRender = useMemo(() => {
    const inactiveContexts = bottomPanelContexts.filter(
      context => context.key !== bottomPanelWorkspaceKey
    )
    return [...inactiveContexts, activeBottomPanelContext]
  }, [activeBottomPanelContext, bottomPanelContexts, bottomPanelWorkspaceKey])

  const reviewRequestSequenceRef = useRef(0)

  const previousTurnReviewRef = useRef<{
    loadDiff: () => Promise<{ diff: string; truncated: boolean }>
    defaultFileTreeVisible?: boolean
    sourceSubtaskId?: string
  } | null>(null)

  const paneMessages = paneSession.messages

  const paneMessagesRef = useRef(paneMessages)

  useEffect(() => {
    paneMessagesRef.current = paneMessages
  }, [paneMessages])

  const pendingRequestUserInput = pendingRequestUserInputPayload(
    paneMessages,
    paneSession.answeredRequestUserInputIds
  )

  const selectedAssistantPlanContent = useMemo(
    () => findSelectedAssistantPlanContent(paneMessages, selectedAssistantPlan),
    [paneMessages, selectedAssistantPlan]
  )

  const rightPanelPlanContent =
    selectedAssistantPlanContent ?? selectedAssistantPlan?.fallbackContent ?? null

  const paneQueuedMessages = paneSession.queuedMessages

  const paneGuidanceMessages = paneSession.guidanceMessages

  const paneIsBusy = paneSession.status.isBusy

  const latestPreviousTurnSubtaskId = useMemo(() => {
    for (let index = paneMessages.length - 1; index >= 0; index -= 1) {
      const message = paneMessages[index]
      if (message.fileChanges && typeof message.subtaskId === 'string') {
        return message.subtaskId
      }
    }

    return null
  }, [paneMessages])

  const rightPanelSessionKey = paneKey

  const previousRightPanelSessionKeyRef = useRef(rightPanelSessionKey)

  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)

  const pendingModelRetryRef = useRef<WorkbenchMessage | null>(null)

  const retryFailedMessage = paneSession.retryFailedMessage

  const [projectMenuOpenSignal, setProjectMenuOpenSignal] = useState(0)

  const [projectMenuAnchorElement, setProjectMenuAnchorElement] =
    useState<HTMLButtonElement | null>(null)

  const hasConversation = paneMessages.length > 0 || currentRuntimeTask

  const hasMainBackground = Boolean(background.imagePath && background.inMain)

  const activeDevice = findWorkbenchDevice(devices, activeDeviceId)

  const activeDeviceSupportsGoal = isGoalCapableWorkbenchDevice(activeDevice, activeDeviceId)

  const currentRuntimeTaskSummary = findRuntimeTask(runtimeWork, currentRuntimeTask)

  const currentRuntimeTaskSupportsGoal = Boolean(
    currentRuntimeTask &&
    (activeDeviceSupportsGoal || currentRuntimeTaskSummary?.runtime === 'kcoder')
  )

  const canEditLastUserMessage = Boolean(
    currentRuntimeTaskSupportsGoal && !paneSession.status.isBusy
  )

  const composerSupportsGoal = currentRuntimeTask
    ? currentRuntimeTaskSupportsGoal
    : activeDeviceSupportsGoal

  const activeDeviceUnavailable = Boolean(activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)

  const showConversationDeviceBanner =
    Boolean(activeDeviceId) && (!activeDevice || activeDevice.status === 'offline')

  const activeDeviceVersionUnsupported = Boolean(
    activeDevice && isDeviceBelowStudioVersion(activeDevice)
  )

  const noStandaloneCompatibleDevice =
    !currentProject &&
    !currentRuntimeTask &&
    !activeDeviceId &&
    !devices.some(device => device.status === 'online' && isStudioCompatibleDevice(device))

  const composerDisabled =
    activeDeviceUnavailable || activeDeviceVersionUnsupported || noStandaloneCompatibleDevice

  const composerDisabledReason = activeDeviceUnavailable
    ? t('workbench.device_status_active_unavailable', {
        device:
          getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
          t('workbench.current_device', '当前设备'),
      })
    : activeDeviceVersionUnsupported
      ? t('workbench.device_status_active_upgrade_required', {
          device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
          version: KCODER_STUDIO_MIN_EXECUTOR_VERSION,
        })
      : noStandaloneCompatibleDevice
        ? t('workbench.device_status_no_online_device')
        : undefined

  const inlineComposerDisabledReason = showConversationDeviceBanner
    ? undefined
    : composerDisabledReason

  const retryFailedMessageAfterModelSelect = useCallback(() => {
    const message = pendingModelRetryRef.current
    if (!message) return
    pendingModelRetryRef.current = null
    queueMicrotask(() => {
      void retryFailedMessage(message, 'current')
    })
  }, [retryFailedMessage])

  const projectChatWithModelSelectorSignal = useMemo<ProjectChatControls>(
    () => ({
      ...projectChat,
      modelSelectorOpenSignal,
      requestModelSelectorOpen: () => setModelSelectorOpenSignal(signal => signal + 1),
      setSelectedModel: model => {
        projectChat.setSelectedModel(model)
        if (model) retryFailedMessageAfterModelSelect()
      },
      setSelectedModelAndOptions: projectChat.setSelectedModelAndOptions
        ? (model, options) => {
            projectChat.setSelectedModelAndOptions?.(model, options)
            retryFailedMessageAfterModelSelect()
          }
        : undefined,
      onModelSelectorOpenChange: open => {
        if (!open) pendingModelRetryRef.current = null
      },
    }),
    [modelSelectorOpenSignal, projectChat, retryFailedMessageAfterModelSelect]
  )

  const emptyProjectWork = useMemo(
    () => ({ ...paneProjectWork, projectMenuOpenSignal, projectMenuAnchorElement }),
    [paneProjectWork, projectMenuAnchorElement, projectMenuOpenSignal]
  )

  const selectTaskSuggestion = useCallback(
    (prompt: string) => {
      paneSession.setInput(prompt)
    },
    [paneSession]
  )

  const openRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
      setRightPanelView(tab)
    },
    [setRightPanelOpen, setRightPanelTabs, setRightPanelView]
  )
  return {
    ...context,
    bottomPanelWorkspaceKey,
    bottomPanelOpen,
    activeBottomPanelContext,
    rememberActiveBottomPanelContext,
    setCurrentBottomPanelOpen,
    bottomPanelContextsToRender,
    reviewRequestSequenceRef,
    previousTurnReviewRef,
    paneMessages,
    paneMessagesRef,
    pendingRequestUserInput,
    selectedAssistantPlanContent,
    rightPanelPlanContent,
    paneQueuedMessages,
    paneGuidanceMessages,
    paneIsBusy,
    latestPreviousTurnSubtaskId,
    rightPanelSessionKey,
    previousRightPanelSessionKeyRef,
    modelSelectorOpenSignal,
    setModelSelectorOpenSignal,
    pendingModelRetryRef,
    retryFailedMessage,
    projectMenuOpenSignal,
    setProjectMenuOpenSignal,
    projectMenuAnchorElement,
    setProjectMenuAnchorElement,
    hasConversation,
    hasMainBackground,
    activeDevice,
    activeDeviceSupportsGoal,
    currentRuntimeTaskSummary,
    currentRuntimeTaskSupportsGoal,
    canEditLastUserMessage,
    composerSupportsGoal,
    activeDeviceUnavailable,
    showConversationDeviceBanner,
    activeDeviceVersionUnsupported,
    noStandaloneCompatibleDevice,
    composerDisabled,
    composerDisabledReason,
    inlineComposerDisabledReason,
    retryFailedMessageAfterModelSelect,
    projectChatWithModelSelectorSignal,
    emptyProjectWork,
    selectTaskSuggestion,
    openRightPanelTab,
  }
}
