import { useHorizontalPaneResize } from '../useHorizontalPaneResize'
import { readWorkspaceMarkdownImage } from '@/components/chat/workspaceMarkdownImage'
import { listSettingsTemplates } from '@/kcoder/configTemplates'
import { settingsTemplateBadgeState } from '@/kcoder/settingsTemplateBadge'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { type EmbeddedBrowserOpenRequest } from '@/lib/embedded-browser'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getActiveWorkbenchDeviceId } from '@/lib/workbench-device'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { resolveProjectRuntimeWorkspaceTargets } from '@/lib/workspace-target'
import { useWorkspaceFileNavigation } from '@/kcoder/useWorkspaceFileNavigation'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type BottomPanelRenderContext,
  type DesktopReviewState,
} from '../desktopWorkbenchPaneTypes'
import { useRuntimeTaskContinueInIm } from '../useRuntimeTaskContinueInIm'
import { useWorkbenchPaneEnvironment } from '../useWorkbenchPaneEnvironment'
import { useWorkbenchProjectWorkControls } from '../useWorkbenchProjectWorkControls'
import {
  type RightWorkspaceChatTab,
  type RightWorkspacePanelTab,
  type RightWorkspacePanelView,
} from '../workspace-panels/RightWorkspacePanel'
import { useResizableRightSplitChat } from '../workspace-panels/useResizableWorkspacePanel'
import {
  COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE,
  DOCKED_ENVIRONMENT_INFO_WIDTH,
  MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO,
  TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH,
} from './paneLayoutStyles'
import { sanitizeEmbeddedBrowserLabelSegment } from './paneSelectors'
import { type SelectedAssistantPlan } from './types'
import type { usePaneCloudBindings } from './usePaneCloudBindings'

export function usePaneWorkspacePanels(context: ReturnType<typeof usePaneCloudBindings>) {
  const {
    pane,
    workflowComposerIntent,
    sidebarResizing,
    summaryVisibility,
    onSummaryVisibilityChange,
    onTerminalPanePinChange,
    initialWorkspaceState,
    onWorkspaceStateChange,
    paneActive,
    state,
    workspaceFileApi,
    t,
    currentRuntimeTask,
    currentProject,
    paneKey,
    initialBlankBrowserMigration,
    paneSession,
    workflowScope,
    workflowView,
    setWorkflowView,
    activeWorkflow,
    activeWorkflowKey,
    runtimeWork,
  } = context
  const projectWork = useWorkbenchProjectWorkControls({
    pane,
    enableShellProjectActions: true,
  })

  const paneEnvironment = useWorkbenchPaneEnvironment({
    pane,
    projectWork,
    environmentRefreshActive: Boolean(currentRuntimeTask && paneSession.status.isBusy),
  })

  const {
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    environmentInfo,
    projectWork: paneProjectWork,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    loadEnvironmentDiff,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
  } = paneEnvironment

  const isBootstrapping = state.isBootstrapping

  const devices = state.devices

  const runtimeTaskWorkspacePath = useMemo(() => {
    if (!runtimeWork || !currentRuntimeTask) return null
    const workspaces = [
      ...runtimeWork.chats,
      ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ]
    const matches = workspaces.filter(workspace =>
      workspace.tasks.some(task => task.taskId === currentRuntimeTask.taskId)
    )
    return (
      matches.find(workspace => workspace.deviceId === currentRuntimeTask.deviceId)
        ?.workspacePath ?? (matches.length === 1 ? matches[0].workspacePath : null)
    )
  }, [currentRuntimeTask, runtimeWork])

  const runtimeTaskDeviceId = currentRuntimeTask?.deviceId ?? null

  const runtimeTaskDirectWorkspacePath = currentRuntimeTask?.workspacePath ?? null

  const readWorkspaceFileChunk = workspaceFileApi?.readWorkspaceFileChunk

  const readWorkspaceFileChunkRef = useRef(readWorkspaceFileChunk)

  useLayoutEffect(() => {
    readWorkspaceFileChunkRef.current = readWorkspaceFileChunk
  }, [readWorkspaceFileChunk])

  const loadWorkspaceMarkdownImage = useCallback(
    async (path: string): Promise<Blob> => {
      const readChunk = readWorkspaceFileChunkRef.current
      if (!runtimeTaskDeviceId || !readChunk) {
        throw new Error('Workspace image loading is unavailable')
      }
      const workspacePath = runtimeTaskDirectWorkspacePath || runtimeTaskWorkspacePath
      if (!workspacePath) throw new Error('Workspace image path is unavailable')
      const absolutePath = /^(?:\/|[a-zA-Z]:[\\/])/.test(path)
        ? path
        : `${workspacePath.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`
      return readWorkspaceMarkdownImage(readChunk, runtimeTaskDeviceId, absolutePath)
    },
    [runtimeTaskDeviceId, runtimeTaskDirectWorkspacePath, runtimeTaskWorkspacePath]
  )

  const [rightPanelOpen, setRightPanelOpen] = useState(
    () =>
      initialBlankBrowserMigration?.rightPanelOpen ?? initialWorkspaceState?.rightPanelOpen ?? false
  )

  const [rightPanelView, setRightPanelView] = useState<RightWorkspacePanelView>(
    () =>
      initialBlankBrowserMigration?.rightPanelView ??
      initialWorkspaceState?.rightPanelView ??
      'launcher'
  )

  const [rightPanelTabs, setRightPanelTabs] = useState<RightWorkspacePanelTab[]>(
    () =>
      initialBlankBrowserMigration?.rightPanelTabs ?? initialWorkspaceState?.rightPanelTabs ?? []
  )

  const [embeddedBrowserUrl, setEmbeddedBrowserUrl] = useState<string | null>(
    () => initialWorkspaceState?.browserUrl ?? null
  )

  useEffect(() => {
    onWorkspaceStateChange(paneKey, {
      rightPanelOpen,
      rightPanelTabs,
      rightPanelView,
      browserUrl: embeddedBrowserUrl,
    })
  }, [
    embeddedBrowserUrl,
    onWorkspaceStateChange,
    paneKey,
    rightPanelOpen,
    rightPanelTabs,
    rightPanelView,
  ])

  const [migratedEmbeddedBrowserLabel, setMigratedEmbeddedBrowserLabel] = useState<string | null>(
    () => initialBlankBrowserMigration?.browserLabel ?? null
  )

  const temporaryChatTabSequenceRef = useRef(0)

  const [embeddedBrowserOpenRequest, setEmbeddedBrowserOpenRequest] = useState<
    (EmbeddedBrowserOpenRequest & { id: number }) | null
  >(() =>
    initialWorkspaceState?.browserUrl
      ? { id: 1, url: initialWorkspaceState.browserUrl, label: '' }
      : null
  )

  const [conversationSelectionInsertion, setConversationSelectionInsertion] = useState<{
    id: number
    text: string
  } | null>(null)

  const temporaryChatInitialInputsRef = useRef(new Map<RightWorkspaceChatTab, string>())

  const [selectedAssistantPlan, setSelectedAssistantPlan] = useState<SelectedAssistantPlan | null>(
    null
  )

  const [bottomPanelOpenByKey, setBottomPanelOpenByKey] = useState<Record<string, boolean>>({})

  const [bottomPanelContexts, setBottomPanelContexts] = useState<BottomPanelRenderContext[]>([])

  const [selectedFileWorkspaceTargetKey, setSelectedFileWorkspaceTargetKey] = useState<
    string | null
  >(null)

  const [forkDialogOpen, setForkDialogOpen] = useState(false)

  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)

  const [hasPreviousTurnReview, setHasPreviousTurnReview] = useState(false)

  const isTauri = isTauriRuntime()

  const workbenchMainRef = useRef<HTMLElement | null>(null)

  const workbenchScrollRef = useRef<HTMLDivElement | null>(null)

  const [workbenchContentWidth, setWorkbenchContentWidth] = useState(0)

  const environmentInfoPanelRef = useRef<HTMLElement | null>(null)

  const [environmentInfoPanelElement, setEnvironmentInfoPanelElement] =
    useState<HTMLElement | null>(null)

  const setEnvironmentInfoPanelRef = useCallback((element: HTMLElement | null) => {
    environmentInfoPanelRef.current = element
  }, [])

  useLayoutEffect(() => {
    setEnvironmentInfoPanelElement(environmentInfoPanelRef.current)
  }, [])

  useLayoutEffect(() => {
    if (!paneActive) return
    const workbenchScroll = workbenchScrollRef.current
    if (workbenchScroll && workbenchScroll.scrollLeft !== 0) {
      workbenchScroll.scrollLeft = 0
    }
  }, [paneActive])

  const continueInIm = useRuntimeTaskContinueInIm(currentRuntimeTask)

  const [reviewState, setReviewState] = useState<DesktopReviewState>({
    loading: false,
    diff: '',
    error: undefined,
    reviewTitle: undefined,
    reviewMode: undefined,
    defaultFileTreeVisible: undefined,
    branchName: undefined,
    targetBranchName: undefined,
    sourceSubtaskId: undefined,
    reloadDiff: undefined,
  })

  const closeRightPanel = useCallback(() => setRightPanelOpen(false), [setRightPanelOpen])

  const onlyTemporaryChatOpen =
    rightPanelTabs.length === 1 &&
    rightPanelTabs[0].startsWith('chat:') &&
    rightPanelView === rightPanelTabs[0]

  useLayoutEffect(() => {
    const workbenchMain = workbenchMainRef.current
    if (!workbenchMain) return

    const updateWorkbenchContentWidth = () => {
      setWorkbenchContentWidth(workbenchMain.getBoundingClientRect().width)
    }

    updateWorkbenchContentWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateWorkbenchContentWidth)
    observer.observe(workbenchMain)
    return () => observer.disconnect()
  }, [])

  const {
    width: rightSplitChatWidth,
    resizing: rightSplitResizing,
    handleResizeStart: handleRightSplitResizeStart,
  } = useResizableRightSplitChat({
    containerRef: workbenchMainRef,
    onCollapse: closeRightPanel,
    defaultPanelWidth: onlyTemporaryChatOpen ? TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH : undefined,
  })

  const workflowSplit = useHorizontalPaneResize({
    containerRef: workbenchMainRef,
    minWidth: 360,
    minRemaining: 320,
  })
  const workflowNarrow = workbenchContentWidth > 0 && workbenchContentWidth < 900

  const workflowPaneExists = Boolean(
    activeWorkflow &&
    currentRuntimeTask?.deviceId &&
    !(workflowView.scope === workflowScope && workflowView.closed === activeWorkflowKey)
  )

  const workflowCanvasVisible = workflowPaneExists && !rightPanelOpen

  const workflowNarrowShown =
    workflowCanvasVisible &&
    workflowNarrow &&
    workflowView.scope === workflowScope &&
    Boolean(workflowView.canvas)

  const closeWorkflowCanvas = () => {
    setWorkflowView(current => ({
      ...current,
      scope: workflowScope,
      ...(workflowNarrow ? { canvas: false } : { closed: activeWorkflowKey }),
    }))
    requestAnimationFrame(() =>
      workbenchMainRef.current
        ?.querySelector<HTMLElement>(
          `[data-workflow-id="${CSS.escape(activeWorkflow?.id ?? '')}"] [data-testid="workflow-card-open"]`
        )
        ?.focus({ preventScroll: true })
    )
  }

  const chatColumnWidth = rightPanelOpen
    ? rightSplitChatWidth
    : workflowCanvasVisible && !workflowNarrow
      ? workflowSplit.width
      : '100%'

  const availableChatColumnWidth = rightPanelOpen
    ? rightSplitChatWidth
    : workflowCanvasVisible && !workflowNarrow
      ? workflowSplit.width
      : workbenchContentWidth

  const environmentInfoDocked =
    Boolean(currentRuntimeTask) &&
    availableChatColumnWidth - DOCKED_ENVIRONMENT_INFO_WIDTH >=
      MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO

  const environmentInfoOpen = environmentInfoDocked
    ? (summaryVisibility?.pinned ?? false)
    : (summaryVisibility?.overlay ?? false)

  const setEnvironmentInfoOpen = useCallback(
    (open: boolean) =>
      onSummaryVisibilityChange(paneKey, environmentInfoDocked ? 'pinned' : 'overlay', open),
    [environmentInfoDocked, onSummaryVisibilityChange, paneKey]
  )

  useEffect(() => {
    if (currentRuntimeTask && !environmentInfoDocked) return
    onSummaryVisibilityChange(paneKey, 'overlay', false)
  }, [currentRuntimeTask, environmentInfoDocked, onSummaryVisibilityChange, paneKey])

  const paneTitleWidth =
    rightPanelOpen || (workflowCanvasVisible && !workflowNarrow) ? chatColumnWidth : '100%'

  const rightPanelShellWidth = rightPanelOpen ? `calc(100% - ${rightSplitChatWidth}px)` : '0px'

  const rightPanelTitlebarWidth = rightPanelOpen
    ? rightPanelShellWidth
    : COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE

  const hasPersistentRightPanelResource = rightPanelTabs.some(
    tab => tab === 'terminal' || tab === 'browser'
  )

  useEffect(() => {
    onTerminalPanePinChange(paneKey, 'right-panel', hasPersistentRightPanelResource)
    return () => onTerminalPanePinChange(paneKey, 'right-panel', false)
  }, [hasPersistentRightPanelResource, onTerminalPanePinChange, paneKey])

  const chatContentResizing = sidebarResizing || rightSplitResizing || workflowSplit.resizing

  const defaultEmbeddedBrowserLabel = currentRuntimeTask?.taskId
    ? `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(currentRuntimeTask.taskId)}`
    : `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(paneKey)}`

  const embeddedBrowserLabel = migratedEmbeddedBrowserLabel ?? defaultEmbeddedBrowserLabel

  const activeDeviceId =
    currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
      currentProject,
      standaloneDeviceId: paneProjectWork.currentStandaloneDeviceId,
    })

  const [settingsTemplateCatalog, setSettingsTemplates] = useState<{
    deviceId: string
    defaultId?: string
    templates: Array<{ id: string; name: string; revisionSha256: string }>
  } | null>(null)

  const settingsTemplates =
    settingsTemplateCatalog?.deviceId === activeDeviceId ? settingsTemplateCatalog : null

  const [settingsTemplateChoice, setSettingsTemplateChoice] = useState<string | undefined>(
    undefined
  )

  useEffect(() => {
    // Only an unsent conversation offers a template choice; running sessions stay frozen but
    // still need the catalog to label the template they are bound to.
    if (!activeDeviceId) return
    let cancelled = false
    void listSettingsTemplates(activeDeviceId)
      .then(catalog => {
        if (cancelled) return
        setSettingsTemplates({
          deviceId: activeDeviceId,
          ...(catalog.defaultId ? { defaultId: catalog.defaultId } : {}),
          templates: catalog.templates.map(template => ({
            id: template.id,
            name: template.name,
            revisionSha256: template.revisionSha256,
          })),
        })
      })
      .catch(() => {
        if (!cancelled) setSettingsTemplates(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeDeviceId, currentRuntimeTask])

  const settingsTemplateBadge = settingsTemplateBadgeState(
    paneSession.sessionTemplateBinding,
    settingsTemplates?.templates
  )

  const settingsTemplatePicker =
    !currentRuntimeTask && settingsTemplates && settingsTemplates.templates.length > 0
      ? {
          ...(settingsTemplateChoice ? { value: settingsTemplateChoice } : {}),
          placeholder: settingsTemplates.defaultId
            ? t('configTemplates.followDefaultWith', {
                name:
                  settingsTemplates.templates.find(
                    template => template.id === settingsTemplates.defaultId
                  )?.name ?? settingsTemplates.defaultId,
              })
            : t('configTemplates.followDefault'),
          options: settingsTemplates.templates.map(template => ({
            id: template.id,
            name: template.name,
            isDefault: template.id === settingsTemplates.defaultId,
          })),
          onChange: setSettingsTemplateChoice,
        }
      : undefined

  const activeRuntimeTargetDevice = activeDeviceId
    ? devices.find(device => device.device_id === activeDeviceId)
    : undefined

  const activeRuntimeTargetCapabilities = activeRuntimeTargetDevice?.capabilities ?? []

  const activeDeviceIsGatewayTarget = activeRuntimeTargetCapabilities.includes('kcoder-gateway')

  const canOpenRuntimeBrowser =
    !activeDeviceIsGatewayTarget || activeRuntimeTargetCapabilities.includes('runtime-browser')

  const soleActiveDeviceWorkspacePath = useMemo(() => {
    if (!runtimeWork || !activeDeviceId) return null
    const workspaces = [
      ...runtimeWork.chats,
      ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ]
    const matches = workspaces.filter(workspace => workspace.deviceId === activeDeviceId)
    return matches.length === 1
      ? matches[0].workspacePath
      : workspaces.length === 1
        ? workspaces[0].workspacePath
        : null
  }, [activeDeviceId, runtimeWork])

  const standaloneRootWorkspaceTarget = useMemo(
    () =>
      !workspaceProject && !workspaceTarget && activeDeviceId
        ? {
            deviceId: activeDeviceId,
            path: '/',
            source: 'runtime' as const,
            workspaceSource: 'remote',
          }
        : null,
    [activeDeviceId, workspaceProject, workspaceTarget]
  )

  const effectiveWorkspaceTarget = workspaceTarget ?? standaloneRootWorkspaceTarget

  const projectFileWorkspaceTargets = useMemo(
    () =>
      resolveProjectRuntimeWorkspaceTargets({
        currentProject: workspaceProject,
        runtimeWork,
      }),
    [runtimeWork, workspaceProject]
  )

  const fileWorkspaceTargets = useMemo(() => {
    const candidates = effectiveWorkspaceTarget
      ? [effectiveWorkspaceTarget, ...projectFileWorkspaceTargets]
      : projectFileWorkspaceTargets
    return candidates.filter(
      (candidate, index) =>
        candidates.findIndex(
          item => item.deviceId === candidate.deviceId && item.path === candidate.path
        ) === index
    )
  }, [effectiveWorkspaceTarget, projectFileWorkspaceTargets])

  // Preserve the original render-local target identity and workflow consumption timing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const composerWorkspaceTarget =
    workspaceTarget ??
    (activeDeviceId && state.standaloneWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: state.standaloneWorkspacePath,
          source: 'runtime' as const,
        }
      : null) ??
    (activeDeviceId && soleActiveDeviceWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: soleActiveDeviceWorkspacePath,
          source: 'runtime' as const,
        }
      : null) ??
    (currentRuntimeTask && (currentRuntimeTask.workspacePath || runtimeTaskWorkspacePath)
      ? {
          deviceId: currentRuntimeTask.deviceId,
          path: currentRuntimeTask.workspacePath || runtimeTaskWorkspacePath!,
          source: 'runtime' as const,
        }
      : null)

  const setWorkflowInput = paneSession.setInput
  const consumeWorkflowIntent = workflowComposerIntent.onChange
  const pendingWorkflowRun = workflowComposerIntent.run
  const pendingWorkflowRecovery = workflowComposerIntent.recovery
  useEffect(() => {
    if (!paneActive || !currentRuntimeTask || !pendingWorkflowRecovery) return
    if (
      currentRuntimeTask.deviceId !== pendingWorkflowRecovery.deviceId ||
      (currentRuntimeTask.threadId !== pendingWorkflowRecovery.threadId &&
        currentRuntimeTask.taskId !==
          `kcoder:${pendingWorkflowRecovery.deviceId}:${pendingWorkflowRecovery.threadId}`)
    )
      return
    const params =
      pendingWorkflowRecovery.targetVersion != null
        ? {
            definition_id: pendingWorkflowRecovery.definitionId,
            version: pendingWorkflowRecovery.targetVersion,
            reuse_from_run: pendingWorkflowRecovery.runId,
          }
        : { resume: pendingWorkflowRecovery.runId }
    const instruction = t('workflowCanvas.recoveryInstruction', { params: JSON.stringify(params) })
    setWorkflowInput(
      paneSession.input.trim() ? `${paneSession.input}\n\n${instruction}` : instruction
    )
    consumeWorkflowIntent({ active: false })
  }, [
    paneActive,
    currentRuntimeTask,
    pendingWorkflowRecovery,
    setWorkflowInput,
    consumeWorkflowIntent,
    paneSession.input,
    t,
  ])

  useEffect(() => {
    if (!paneActive || currentRuntimeTask || !pendingWorkflowRun || !composerWorkspaceTarget) return
    if (
      pendingWorkflowRun.deviceId &&
      pendingWorkflowRun.deviceId !== composerWorkspaceTarget.deviceId
    )
      return
    if (
      pendingWorkflowRun.workspacePath &&
      !sameWorkspacePath(pendingWorkflowRun.workspacePath, composerWorkspaceTarget.path)
    )
      return
    setWorkflowInput(
      t('workflowCanvas.runInstruction', {
        params: JSON.stringify({
          definition_id: pendingWorkflowRun.id,
          version: pendingWorkflowRun.version,
          ...(pendingWorkflowRun.args !== undefined ? { args: pendingWorkflowRun.args } : {}),
          ...(pendingWorkflowRun.verificationScenario
            ? { verification_scenario: pendingWorkflowRun.verificationScenario }
            : {}),
        }),
      })
    )
    consumeWorkflowIntent({ active: false })
    const url = new URL(window.location.href)
    if (url.searchParams.has('workflowRun')) {
      url.searchParams.delete('workflowRun')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [
    paneActive,
    currentRuntimeTask,
    pendingWorkflowRun,
    composerWorkspaceTarget,
    setWorkflowInput,
    consumeWorkflowIntent,
    t,
  ])

  const selectedFileWorkspaceTarget =
    fileWorkspaceTargets.find(
      target => `${target.deviceId}:${target.path}` === selectedFileWorkspaceTargetKey
    ) ?? null

  const fileOwnerScope = JSON.stringify([
    paneKey,
    currentRuntimeTask
      ? [currentRuntimeTask.deviceId, currentRuntimeTask.taskId]
      : [
          effectiveWorkspaceTarget?.deviceId,
          effectiveWorkspaceTarget?.path,
          effectiveWorkspaceTarget?.source,
        ],
  ])
  const {
    fileNavigationScope,
    openFileRequest,
    setOpenFileRequest,
    beginFileOpenRequest,
    commitFileOpenRequest,
    cancelFileOpenRequest,
    committedFileWorkspaceTarget,
  } = useWorkspaceFileNavigation(
    fileOwnerScope,
    selectedFileWorkspaceTarget ?? effectiveWorkspaceTarget,
    currentRuntimeTask?.deviceId ?? effectiveWorkspaceTarget?.deviceId
  )
  const fileWorkspaceTarget =
    committedFileWorkspaceTarget ?? selectedFileWorkspaceTarget ?? effectiveWorkspaceTarget

  const fileWorkspaceTargetError =
    openFileRequest?.target || committedFileWorkspaceTarget || selectedFileWorkspaceTarget
      ? null
      : workspaceTargetError
  const canBrowseFiles =
    Boolean(
      workspaceProject ||
      openFileRequest?.target ||
      committedFileWorkspaceTarget ||
      selectedFileWorkspaceTarget
    ) &&
    (!activeDeviceIsGatewayTarget ||
      activeRuntimeTargetCapabilities.includes('runtime-workspace-files'))

  const effectiveRightPanelTabs = useMemo<RightWorkspacePanelTab[]>(() => {
    const permittedTabs = rightPanelTabs.filter(
      tab => (canBrowseFiles || tab !== 'files') && (canOpenRuntimeBrowser || tab !== 'browser')
    )
    if (
      rightPanelView === 'launcher' ||
      (!canBrowseFiles && rightPanelView === 'files') ||
      (!canOpenRuntimeBrowser && rightPanelView === 'browser')
    ) {
      return permittedTabs
    }
    return permittedTabs.includes(rightPanelView)
      ? permittedTabs
      : [...permittedTabs, rightPanelView]
  }, [canBrowseFiles, canOpenRuntimeBrowser, rightPanelTabs, rightPanelView])

  const shouldRenderRightPanel = rightPanelOpen || effectiveRightPanelTabs.length > 0

  const workspaceTargetDevice = effectiveWorkspaceTarget?.deviceId
    ? devices.find(device => device.device_id === effectiveWorkspaceTarget.deviceId)
    : undefined

  const workspaceTargetUsesRemoteDevice = Boolean(
    workspaceTargetDevice &&
    (isCloudDevice(workspaceTargetDevice) || isRemoteDevice(workspaceTargetDevice))
  )

  const workspaceTargetUsesRemoteSource = effectiveWorkspaceTarget?.workspaceSource === 'remote'

  const preferLocalWorkspaceTerminal =
    paneProjectWork.executionMode === 'current_workspace' &&
    effectiveWorkspaceTarget?.source !== 'runtime' &&
    !workspaceTargetUsesRemoteDevice &&
    !workspaceTargetUsesRemoteSource
  return {
    ...context,
    projectWork,
    paneEnvironment,
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    environmentInfo,
    paneProjectWork,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    loadEnvironmentDiff,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    isBootstrapping,
    devices,
    runtimeTaskWorkspacePath,
    runtimeTaskDeviceId,
    runtimeTaskDirectWorkspacePath,
    readWorkspaceFileChunk,
    readWorkspaceFileChunkRef,
    loadWorkspaceMarkdownImage,
    rightPanelOpen,
    setRightPanelOpen,
    rightPanelView,
    setRightPanelView,
    rightPanelTabs,
    setRightPanelTabs,
    embeddedBrowserUrl,
    setEmbeddedBrowserUrl,
    migratedEmbeddedBrowserLabel,
    setMigratedEmbeddedBrowserLabel,
    temporaryChatTabSequenceRef,
    embeddedBrowserOpenRequest,
    setEmbeddedBrowserOpenRequest,
    conversationSelectionInsertion,
    setConversationSelectionInsertion,
    temporaryChatInitialInputsRef,
    selectedAssistantPlan,
    setSelectedAssistantPlan,
    bottomPanelOpenByKey,
    setBottomPanelOpenByKey,
    bottomPanelContexts,
    setBottomPanelContexts,
    openFileRequest,
    setOpenFileRequest,
    fileNavigationScope,
    beginFileOpenRequest,
    commitFileOpenRequest,
    cancelFileOpenRequest,
    selectedFileWorkspaceTargetKey,
    setSelectedFileWorkspaceTargetKey,
    forkDialogOpen,
    setForkDialogOpen,
    feedbackDialogOpen,
    setFeedbackDialogOpen,
    hasPreviousTurnReview,
    setHasPreviousTurnReview,
    isTauri,
    workbenchMainRef,
    workbenchScrollRef,
    workbenchContentWidth,
    setWorkbenchContentWidth,
    environmentInfoPanelRef,
    environmentInfoPanelElement,
    setEnvironmentInfoPanelElement,
    setEnvironmentInfoPanelRef,
    continueInIm,
    reviewState,
    setReviewState,
    closeRightPanel,
    onlyTemporaryChatOpen,
    rightSplitChatWidth,
    rightSplitResizing,
    handleRightSplitResizeStart,
    workflowNarrow,
    workflowPaneExists,
    workflowCanvasVisible,
    workflowSplit,
    workflowNarrowShown,
    closeWorkflowCanvas,
    chatColumnWidth,
    availableChatColumnWidth,
    environmentInfoDocked,
    environmentInfoOpen,
    setEnvironmentInfoOpen,
    paneTitleWidth,
    rightPanelShellWidth,
    rightPanelTitlebarWidth,
    hasPersistentRightPanelResource,
    chatContentResizing,
    defaultEmbeddedBrowserLabel,
    embeddedBrowserLabel,
    activeDeviceId,
    settingsTemplateCatalog,
    setSettingsTemplates,
    settingsTemplates,
    settingsTemplateChoice,
    setSettingsTemplateChoice,
    settingsTemplateBadge,
    settingsTemplatePicker,
    activeRuntimeTargetDevice,
    activeRuntimeTargetCapabilities,
    activeDeviceIsGatewayTarget,
    canOpenRuntimeBrowser,
    soleActiveDeviceWorkspacePath,
    standaloneRootWorkspaceTarget,
    effectiveWorkspaceTarget,
    projectFileWorkspaceTargets,
    fileWorkspaceTargets,
    composerWorkspaceTarget,
    pendingWorkflowRun,
    selectedFileWorkspaceTarget,
    fileWorkspaceTarget,
    fileWorkspaceTargetError,
    canBrowseFiles,
    effectiveRightPanelTabs,
    shouldRenderRightPanel,
    workspaceTargetDevice,
    workspaceTargetUsesRemoteDevice,
    workspaceTargetUsesRemoteSource,
    preferLocalWorkspaceTerminal,
  }
}
