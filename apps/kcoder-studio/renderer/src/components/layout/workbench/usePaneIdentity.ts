import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { type LocalWorkItem } from '@/features/todo/todoModel'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  findRuntimeTask,
  truncateRuntimeTaskTitle,
} from '@/features/workbench/workbenchRuntimeHelpers'
import {
  workflowReferenceKey,
  refreshedWorkflowReference,
  workflowReferences,
  type WorkflowReference,
} from '@/features/workflows/workflowReferences'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeAdditionalContext } from '@/types/api'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchPaneSession } from '../useWorkbenchPaneSession'
import { getWorkbenchPaneKey } from '../workbenchPaneIdentity'
import { useWorkbenchPaneActive } from '../workbenchPaneStack'
import { cloudBindingState, pendingProjectForTask, pendingTodoForTask } from './cloudBindings'
import { type DesktopWorkbenchPaneProps, type PendingBlankBrowserMigration } from './types'
import { consumeLatestBlankBrowserMigration } from './workspacePanelPersistence'

export function usePaneIdentity({
  pane,
  workflowComposerIntent,
  workbenchVisible,
  sidebarCollapsed,
  sidebarResizing = false,
  workspaceSessionApi,
  summaryVisibility,
  onSummaryVisibilityChange,
  onSidebarCollapsedChange,
  onTerminalPanePinChange,
  initialWorkspaceState,
  onWorkspaceStateChange,
}: DesktopWorkbenchPaneProps) {
  const paneActive = useWorkbenchPaneActive()

  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()

  const appearanceContext = useOptionalAppearance()

  const appearance = appearanceContext?.appearance ?? defaultAppearance

  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')

  const {
    state,
    workspaceFileApi,
    upgradingDevices,
    projectChat,
    upgradeDevice,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    startNewChat,
  } = useWorkbenchPaneContext()

  const { services, openStandaloneWorkspace } = useWorkbench()

  const { t } = useTranslation('common')

  const { t: tChat } = useTranslation('chat')

  const currentRuntimeTask = pane.currentRuntimeTask

  const currentProject = pane.currentProject

  const paneKey = getWorkbenchPaneKey(pane)

  const [turnNavigationPortalTarget, setTurnNavigationPortalTarget] =
    useState<HTMLDivElement | null>(null)

  const [initialBlankBrowserMigration] = useState<PendingBlankBrowserMigration | null>(() =>
    currentRuntimeTask ? consumeLatestBlankBrowserMigration() : null
  )

  const [environmentInfoTransitionEnabled, setEnvironmentInfoTransitionEnabled] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEnvironmentInfoTransitionEnabled(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask })

  const workflowComposerInput = useRef(paneSession.input)

  useLayoutEffect(() => {
    workflowComposerInput.current = paneSession.input
  }, [paneSession.input])

  const workflowScope = `${currentRuntimeTask?.deviceId ?? ''}:${currentRuntimeTask?.taskId ?? ''}`

  const workflowRefs = useMemo(() => {
    const refs = workflowReferences(paneSession.messages)
    if (
      paneSession.workflowDefinitionId &&
      !refs.some(ref => ref.id === paneSession.workflowDefinitionId)
    )
      refs.push({ id: paneSession.workflowDefinitionId, title: '' })
    return refs
  }, [paneSession.messages, paneSession.workflowDefinitionId])

  const [workflowView, setWorkflowView] = useState<{
    scope: string
    reference?: WorkflowReference
    closed?: string
    canvas?: boolean
  }>({ scope: '' })

  const [workflowDirty, setWorkflowDirty] = useState<{
    scope: string
    key: string
    dirty: boolean
  }>({ scope: '', key: '', dirty: false })

  const automaticWorkflow = paneSession.workflowDefinitionId
    ? { id: paneSession.workflowDefinitionId, title: '' }
    : [...workflowRefs].reverse().find(ref => ref.runId)

  const requestedWorkflow =
    workflowView.scope === workflowScope ? workflowView.reference : undefined

  const activeWorkflow = requestedWorkflow
    ? refreshedWorkflowReference(requestedWorkflow, workflowRefs)
    : automaticWorkflow

  const activeWorkflowKey = activeWorkflow ? workflowReferenceKey(activeWorkflow) : ''

  const onWorkflowDirtyChange = useCallback(
    (dirty: boolean) =>
      setWorkflowDirty(previous =>
        previous.scope === workflowScope &&
        previous.key === activeWorkflowKey &&
        previous.dirty === dirty
          ? previous
          : { scope: workflowScope, key: activeWorkflowKey, dirty }
      ),
    [workflowScope, activeWorkflowKey]
  )

  const workflowHasDirtyEditor =
    workflowDirty.scope === workflowScope &&
    workflowDirty.key === activeWorkflowKey &&
    workflowDirty.dirty

  const sendPaneInput = paneSession.send

  const [subagentArtifact, setSubagentArtifact] = useState<{
    title: string
    content: string
    truncated: boolean
  } | null>(null)

  const [deliveryItem, setDeliveryItem] = useState<Omit<LocalWorkItem, 'projectId'> | null>(null)

  const [boundCloudProject, setBoundCloudProject] = useState<CloudProject | null>(null)

  const [boundCloudItem, setBoundCloudItem] = useState<CloudLoopItem | null>(null)

  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false)

  const [todoBindingPickerOpen, setTodoBindingPickerOpen] = useState(false)

  const [deliverAfterBinding, setDeliverAfterBinding] = useState(false)

  const [pendingTodoItem, setPendingTodoItemState] = useState<CloudLoopItem | null>(() =>
    pendingTodoForTask(currentRuntimeTask)
  )

  const [pendingCloudProject, setPendingCloudProject] = useState<CloudProject | null>(() =>
    pendingProjectForTask(currentRuntimeTask)
  )

  const [todoBindingError, setTodoBindingError] = useState<string | null>(null)

  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([])

  const [cloudActionNotice, setCloudActionNotice] = useState<string | null>(null)

  const [cloudMentionState, setCloudMentionState] = useState<{
    todoId: string
    candidates: ComposerCloudMentionCandidate[]
  } | null>(null)

  const runtimeWork = state.runtimeWork

  const runtimeTaskTitle = truncateRuntimeTaskTitle(
    findRuntimeTask(runtimeWork, currentRuntimeTask)?.title
  )

  const composerCloudProject = currentRuntimeTask ? boundCloudProject : pendingCloudProject

  const composerTodoItem = currentRuntimeTask ? boundCloudItem : pendingTodoItem

  const cloudAdditionalContext = useMemo<RuntimeAdditionalContext | undefined>(() => {
    if (!composerCloudProject) return undefined
    const projectReference = `cloud://projects/${composerCloudProject.id}`
    const todoReference = composerTodoItem
      ? `${projectReference}/todos/${composerTodoItem.id}`
      : null
    const scope = composerTodoItem
      ? [
          `Current cloud project: ${composerCloudProject.name} (id=${composerCloudProject.id}).`,
          `Current task: ${composerTodoItem.id} — ${composerTodoItem.title}.`,
          composerTodoItem.description ? `Task description: ${composerTodoItem.description}` : null,
          `Current task reference: ${todoReference}.`,
        ]
      : [
          `Current cloud project: ${composerCloudProject.name} (id=${composerCloudProject.id}).`,
          'No specific task is selected.',
          `Current project reference: ${projectReference}.`,
        ]
    return {
      cloudCollaboration: {
        kind: 'application',
        value: [
          ...scope.filter((line): line is string => Boolean(line)),
          'When the user refers to “this project” or “this task”, use this current cloud context.',
          'Use the wegent_delivery MCP tools to inspect task details, shared files, and deliveries when needed. Do not ask for an id that is already provided here.',
        ].join('\n'),
      },
    }
  }, [composerCloudProject, composerTodoItem])

  const setPendingCloudContext = useCallback(
    (project: CloudProject | null, item: CloudLoopItem | null) => {
      cloudBindingState.pendingTodoBinding = project ? { project, item, target: null } : null
      setPendingCloudProject(project)
      setPendingTodoItemState(item)
    },
    []
  )
  return {
    pane,
    workflowComposerIntent,
    workbenchVisible,
    sidebarCollapsed,
    sidebarResizing,
    workspaceSessionApi,
    summaryVisibility,
    onSummaryVisibilityChange,
    onSidebarCollapsedChange,
    onTerminalPanePinChange,
    initialWorkspaceState,
    onWorkspaceStateChange,
    paneActive,
    experimentalFeaturesEnabled,
    appearanceContext,
    appearance,
    background,
    state,
    workspaceFileApi,
    upgradingDevices,
    projectChat,
    upgradeDevice,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    startNewChat,
    services,
    openStandaloneWorkspace,
    t,
    tChat,
    currentRuntimeTask,
    currentProject,
    paneKey,
    turnNavigationPortalTarget,
    setTurnNavigationPortalTarget,
    initialBlankBrowserMigration,
    environmentInfoTransitionEnabled,
    setEnvironmentInfoTransitionEnabled,
    paneSession,
    workflowComposerInput,
    workflowScope,
    workflowRefs,
    workflowView,
    setWorkflowView,
    workflowDirty,
    setWorkflowDirty,
    automaticWorkflow,
    requestedWorkflow,
    activeWorkflow,
    activeWorkflowKey,
    onWorkflowDirtyChange,
    workflowHasDirtyEditor,
    sendPaneInput,
    subagentArtifact,
    setSubagentArtifact,
    deliveryItem,
    setDeliveryItem,
    boundCloudProject,
    setBoundCloudProject,
    boundCloudItem,
    setBoundCloudItem,
    deliveryDialogOpen,
    setDeliveryDialogOpen,
    todoBindingPickerOpen,
    setTodoBindingPickerOpen,
    deliverAfterBinding,
    setDeliverAfterBinding,
    pendingTodoItem,
    setPendingTodoItemState,
    pendingCloudProject,
    setPendingCloudProject,
    todoBindingError,
    setTodoBindingError,
    cloudProjects,
    setCloudProjects,
    cloudActionNotice,
    setCloudActionNotice,
    cloudMentionState,
    setCloudMentionState,
    runtimeWork,
    runtimeTaskTitle,
    composerCloudProject,
    composerTodoItem,
    cloudAdditionalContext,
    setPendingCloudContext,
  }
}
