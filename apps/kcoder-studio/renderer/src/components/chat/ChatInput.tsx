import { Layers } from 'lucide-react'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { visibleRuntimeGoal } from '@/lib/runtime-goal'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelOptions,
  PluginPathComponent,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeContextUsage,
  RuntimeGoal,
  RuntimeExecutionModes,
  RuntimeSessionMode,
  RuntimeSessionModesResponse,
  RuntimePlanEventPayload,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  SkillRef,
  UnifiedModel,
  UnifiedSkill,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { parseComposerSlashInput } from './composer/composerAutocomplete'
import type { CloudProject } from '@/api/deliveries'
import type { ComposerCloudMentionCandidate } from './composer/composerMentionCandidates'
import {
  buildConversationMentionCandidates,
  type ConversationMentionCandidate,
} from '@/lib/conversation-mentions'
import { ConversationQueuePanel } from './ConversationQueuePanel'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { GoalStatusBar } from './composer/GoalStatusBar'
import { ComposerModePill } from './composer/GoalDraftPill'
import { ExecutionModeInfo } from './composer/ExecutionModeInfo'
import type { ComposerExecutionMode } from './composer/composerExecutionModes'
import { ProjectChatComposer } from './composer/ProjectChatComposer'
import { TaskPlanProgress } from './composer/TaskPlanProgress'

export type ProjectCreateMode = 'scratch' | 'existing' | 'git'

export interface ProjectChatControls {
  scopeKey?: string
  models: UnifiedModel[]
  skills: UnifiedSkill[]
  selectedModel: UnifiedModel | null
  activeModel?: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isModelSelectionReady?: boolean
  trialTemplates?: PluginPathComponent[]
  selectedSkills: SkillRef[]
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number; cancel?: () => void }>
  errors: Map<string, string>
  contextUsage?: RuntimeContextUsage
  isOptionsLocked: boolean
  modelSelectorOpenSignal?: number
  requestModelSelectorOpen?: () => void
  onModelSelectorOpenChange?: (open: boolean) => void
  setSelectedModel: (model: UnifiedModel | null) => void
  setSelectedModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  setSelectedModelOption: (optionId: string, value: string) => void
  getSelectedModel?: () => UnifiedModel | null
  getSelectedModelOptions?: () => ModelOptions
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  toggleSkill: (skill: SkillRef) => void
  handleFileSelect: (files: File | File[]) => Promise<void>
  cancelUpload?: (fileId: string) => void
  removeAttachment: (attachmentId: number) => Promise<void>
  listLocalSkills: () => Promise<LocalDeviceSkill[]>
  listLocalApps?: () => Promise<LocalDeviceApp[]>
}

export interface ProjectWorkControls {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentProject?: ProjectWithTasks | null
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  currentRuntimeDeviceId?: string | null
  currentRuntimeTask?: RuntimeTaskAddress | null
  selectedDeviceWorkspaceId?: number | null
  pendingProjectWorkspaceProjectId?: number | null
  executionMode: ProjectExecutionMode
  executionModeLocked?: boolean
  isGitProject?: boolean
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
  onSelectProjectWorkspace?: (projectId: number, deviceWorkspaceId: number | null) => void
  onBindProjectWorkspace?: (projectId: number) => void
  onExecutionModeChange: (mode: ProjectExecutionMode) => void
  onCreateProjectMode?: (mode: ProjectCreateMode) => void
  branchName?: string
  branchLoading?: boolean
  onRefreshBranch?: () => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  worktreeBranch?: string | null
  onWorktreeBranchChange?: (branchName: string | null) => void
  projectMenuOpenSignal?: number
  projectMenuAnchorElement?: HTMLElement | null
}

export interface ChatInputProps {
  sessionMode?: RuntimeSessionMode
  /** Read-only template badge for a running session; the choice stays frozen. */
  settingsTemplateBadge?: {
    name: string
    status: 'current' | 'drifted' | 'missing'
  }
  /** Session settings template choice for a not-yet-started conversation. */
  settingsTemplatePicker?: {
    value?: string
    placeholder: string
    options: Array<{ id: string; name: string; isDefault: boolean }>
    onChange: (id?: string) => void
  }
  onInspectExecutionModes?: () => Promise<RuntimeSessionModesResponse>
  value: string
  onChange: (value: string) => void
  onSubmit: (valueOverride?: string, options?: ChatSubmitOptions) => void | Promise<void>
  disabled: boolean
  submitDisabled?: boolean
  error?: string | null
  disabledReason?: string
  placeholder?: string
  variant?: 'compact' | 'desktop'
  projectChat?: ProjectChatControls
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  queuedMessages?: QueuedWorkbenchMessage[]
  guidanceMessages?: GuidanceWorkbenchMessage[]
  codeComments?: CodeCommentContext[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onInterruptAndSendQueuedMessage?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onReorderQueuedMessages?: (sourceId: string, targetId: string) => void
  queuePaused?: boolean
  onResumeQueue?: () => void
  onResumeQueueWithInput?: (
    valueOverride?: string,
    options?: ChatSubmitOptions
  ) => void | Promise<void>
  onClearQueue?: () => void
  onCancelGuidanceMessage?: (id: string) => void
  onClearCodeComments?: () => void
  onOpenSkillFile?: (path: string) => void
  workspaceTarget?: WorkspaceTarget | null
  workspaceFileApi?: WorkspaceFileApi
  cloudMentionCandidates?: ComposerCloudMentionCandidate[]
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  cloudSpaceEnabled?: boolean
  onSelectCloudProject?: (project: CloudProject) => void
  isStreaming?: boolean
  onPause?: () => void
  onShortenWait?: () => void
  shortenWaitAvailable?: boolean
  toolbarLeadingContext?: ReactNode
  onCompactContext?: () => void | Promise<void>
  goal?: RuntimeGoal | null
  goalContinuing?: boolean
  taskPlan?: RuntimePlanEventPayload | null
  goalDraftActive?: boolean
  goalDraftMode?: RuntimeGoal['mode']
  onSetGoal?: (mode?: RuntimeGoal['mode']) => void
  onCancelGoalDraft?: () => void
  onEditGoal?: () => void
  onPauseGoal?: () => void
  onResumeGoal?: () => void
  onClearGoal?: () => void
}

export interface ChatSubmitOptions extends RuntimeExecutionModes {
  onExecutionModeAccepted?: () => void
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
}

interface PendingQueuedSend {
  valueOverride?: string
  options?: ChatSubmitOptions
}

interface PendingModelSelection {
  model: UnifiedModel | null
  options?: ModelOptions
}

function isSameModel(left: UnifiedModel | null | undefined, right: UnifiedModel | null): boolean {
  return left?.name === right?.name && left?.type === right?.type
}

function PluginTrialTemplateStrip({ templates }: { templates: PluginPathComponent[] }) {
  const { t } = useTranslation('common')
  const visibleTemplates = templates.filter(template => !template.unavailableReason).slice(0, 8)
  if (visibleTemplates.length === 0) return null

  return (
    <section
      className="mb-2 rounded-2xl border border-border/70 bg-background px-3 py-3 shadow-[0_10px_32px_rgba(0,0,0,0.06)]"
      data-testid="plugin-trial-template-strip"
      aria-label={t('workbench.plugin_trial_templates', '模板')}
    >
      <div className="mb-2 text-sm font-medium leading-5 text-text-muted">
        {t('workbench.plugin_trial_templates', '模板')}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {visibleTemplates.map(template => (
          <div
            key={template.path}
            className="w-[132px] shrink-0 rounded-xl border border-border/70 bg-surface/50 p-3"
            data-testid="plugin-trial-template-card"
          >
            <div className="mb-3 flex h-[72px] items-center justify-center rounded-lg border border-border/60 bg-background">
              {template.logoUrl || template.logoUrlDark ? (
                <img
                  src={template.logoUrl || template.logoUrlDark || ''}
                  alt=""
                  className="h-9 w-9 object-contain"
                />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-sm font-medium text-text-secondary">
                  {template.name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <div className="truncate text-sm font-medium leading-5 text-text-primary">
              {template.name}
            </div>
            {template.description ? (
              <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-text-muted">
                {template.description}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  submitDisabled = false,
  error,
  disabledReason,
  placeholder,
  variant = 'compact',
  projectChat,
  projectWork,
  showProjectWorkBar = true,
  queuedMessages = [],
  guidanceMessages = [],
  codeComments = [],
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onInterruptAndSendQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessages,
  queuePaused,
  onResumeQueue,
  onResumeQueueWithInput,
  onClearQueue,
  onCancelGuidanceMessage,
  onClearCodeComments,
  onOpenSkillFile,
  workspaceTarget,
  workspaceFileApi,
  cloudMentionCandidates,
  cloudProjectCandidates,
  cloudSpaceEnabled,
  onSelectCloudProject,
  isStreaming = false,
  onPause,
  onShortenWait,
  shortenWaitAvailable,
  toolbarLeadingContext,
  onCompactContext,
  goal,
  goalContinuing = false,
  taskPlan,
  goalDraftActive = false,
  goalDraftMode = 'standard',
  onSetGoal,
  sessionMode,
  settingsTemplatePicker,
  settingsTemplateBadge,
  onInspectExecutionModes,
  onCancelGoalDraft,
  onEditGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
}: ChatInputProps) {
  const [slashSubmitError, setSlashSubmitError] = useState<string | null>(null)
  const [executionDraft, setExecutionDraft] = useState<{
    scope: string
    mode: ComposerExecutionMode
  } | null>(null)
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  const [pendingQueuedSend, setPendingQueuedSend] = useState<PendingQueuedSend | null>(null)
  const [pendingModelSelection, setPendingModelSelection] = useState<PendingModelSelection | null>(
    null
  )
  const displayedGoal = visibleRuntimeGoal(goal)
  const inputPlaceholder = goalDraftActive
    ? goalDraftMode === 'strict'
      ? t('workbench.goal_pro_input_placeholder', '输入需要独立验证完成情况的目标')
      : goalDraftMode === 'arrangement'
        ? t('workbench.ultgoal_input_placeholder', '输入需要多智能体编排完成的目标')
        : t('workbench.goal_input_placeholder', 'KCoder Studio 应该往哪个方向努力?')
    : (placeholder ?? t('workbench.input_placeholder', '随心输入'))
  const controls: ProjectChatControls = projectChat ?? {
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    isModelSelectionReady: true,
    trialTemplates: [],
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    contextUsage: undefined,
    isOptionsLocked: false,
    modelSelectorOpenSignal: undefined,
    requestModelSelectorOpen: undefined,
    setSelectedModel: () => {},
    setSelectedModelOption: () => {},
    onBlockedModelSelect: () => {},
    toggleSkill: () => {},
    handleFileSelect: async () => {},
    cancelUpload: () => {},
    removeAttachment: async () => {},
    listLocalSkills: async () => [],
    listLocalApps: async () => [],
  }
  const conversationMentionCandidates = useMemo(
    () =>
      buildConversationMentionCandidates(
        projectWork?.runtimeWork,
        projectWork?.currentRuntimeTask
      ).map(candidate => conversationMentionCandidate(candidate, t)),
    [projectWork?.currentRuntimeTask, projectWork?.runtimeWork, t]
  )

  const planModeActive = controls.selectedModelOptions.collaborationMode === 'plan'
  const handleSetPlanMode = () => {
    if (goalDraftActive) {
      onCancelGoalDraft?.()
    }
    controls.setSelectedModelOption('collaborationMode', 'plan')
  }
  const handleClearPlanMode = () => {
    controls.setSelectedModelOption('collaborationMode', 'default')
  }
  const handleCompactContext = onCompactContext
    ? () => {
        void onCompactContext()
      }
    : undefined

  const applyModelSelection = (model: UnifiedModel | null, options?: ModelOptions) => {
    if (options && model && controls.setSelectedModelAndOptions) {
      controls.setSelectedModelAndOptions(model, options)
      return
    }
    controls.setSelectedModel(model)
  }

  const requestModelSelection = (model: UnifiedModel | null, options?: ModelOptions) => {
    const selectionChangesModel = !isSameModel(controls.selectedModel, model)
    if (
      selectionChangesModel &&
      controls.activeModel &&
      !isSameModel(controls.activeModel, model)
    ) {
      setPendingModelSelection({ model, options })
      return
    }
    applyModelSelection(model, options)
  }

  const confirmModelSelection = () => {
    if (!pendingModelSelection) return
    const { model, options } = pendingModelSelection
    setPendingModelSelection(null)
    applyModelSelection(model, options)
  }

  const executionScope = `${controls.scopeKey ?? workspaceTarget?.path ?? ''}:${projectWork?.currentRuntimeTask?.taskId ?? 'draft'}`
  const executionMode = executionDraft?.scope === executionScope ? executionDraft.mode : null
  const modeQueryRef = useRef(0)
  const executionScopeRef = useRef(executionScope)
  useLayoutEffect(() => {
    executionScopeRef.current = executionScope
  }, [executionScope])
  const [modeInfo, setModeInfo] = useState<{ scope: string; text: string } | null>(null)
  const canSelectOrchestrate = !projectWork?.currentRuntimeTask && !isStreaming
  const selectExecutionMode = (mode: ComposerExecutionMode) => {
    if (mode === 'orchestrate' && !canSelectOrchestrate) {
      setSlashSubmitError(t('workbench.orchestrate_before_first_message'))
      return
    }
    setSlashSubmitError(null)
    onCancelGoalDraft?.()
    handleClearPlanMode()
    setExecutionDraft({ scope: executionScope, mode })
    setModeInfo(null)
    const query = ++modeQueryRef.current
    if (mode !== 'orchestrate' && onInspectExecutionModes) {
      void onInspectExecutionModes()
        .then(result => {
          if (query !== modeQueryRef.current || executionScopeRef.current !== executionScope) return
          if (mode === 'moa-plan' && result.moaPlanError) {
            setSlashSubmitError(result.moaPlanError)
          } else {
            setModeInfo({
              scope: executionScope,
              text: mode === 'moa' ? result.moaSummary : result.moaPlanPlanners.join('\n'),
            })
          }
        })
        .catch(error => {
          if (query === modeQueryRef.current && executionScopeRef.current === executionScope) {
            setSlashSubmitError(error instanceof Error ? error.message : String(error))
          }
        })
    }
  }
  const executionModes = onSetGoal
    ? { canSelectOrchestrate, onSelect: selectExecutionMode }
    : undefined
  const selectGoal = onSetGoal
    ? (mode?: RuntimeGoal['mode']) => {
        modeQueryRef.current += 1
        setModeInfo(null)
        setExecutionDraft(null)
        onSetGoal(mode)
      }
    : undefined
  const selectPlanMode = () => {
    modeQueryRef.current += 1
    setModeInfo(null)
    setExecutionDraft(null)
    handleSetPlanMode()
  }

  const handleSubmit = (valueOverride?: string, options?: ChatSubmitOptions) => {
    const submittedValue = (valueOverride ?? value).trim()
    const slashInput = parseComposerSlashInput(submittedValue)
    if (slashInput) {
      const goalMode =
        slashInput.name === '/goal-pro'
          ? 'strict'
          : slashInput.name === '/ultgoal'
            ? 'arrangement'
            : slashInput.name === '/goal'
              ? 'standard'
              : null
      if (slashInput.name === '/') {
        setSlashSubmitError(t('workbench.slash_command_required', '请输入 slash 指令名称'))
        return
      }
      if (goalMode && onSetGoal) {
        setSlashSubmitError(null)
        selectGoal?.(goalMode)
        onChange(slashInput.args ?? '')
        return
      }
      if (slashInput.name === '/plan') {
        setSlashSubmitError(null)
        selectPlanMode()
        onChange(slashInput.args ?? '')
        return
      }
      if (executionModes && ['/orchestrate', '/moa', '/moa-plan'].includes(slashInput.name)) {
        const mode = slashInput.name.slice(1) as ComposerExecutionMode
        if (mode === 'orchestrate' && slashInput.args) {
          setSlashSubmitError(t('workbench.orchestrate_no_arguments'))
          return
        }
        selectExecutionMode(mode)
        onChange(slashInput.args ?? '')
        return
      }
      if (slashInput.name === '/compact' && !slashInput.args && handleCompactContext) {
        setSlashSubmitError(null)
        onChange('')
        handleCompactContext()
        return
      }
      if (slashInput.name === '/model' && !slashInput.args && controls.requestModelSelectorOpen) {
        setSlashSubmitError(null)
        onChange('')
        controls.requestModelSelectorOpen()
        return
      }
      setSlashSubmitError(
        t(
          'workbench.slash_command_unknown_or_incomplete',
          `未知或不完整的 slash 指令：${slashInput.name}`,
          { command: slashInput.name }
        )
      )
      return
    }
    setSlashSubmitError(null)
    if (settingsTemplatePicker?.value) {
      options = { ...options, settingsTemplate: settingsTemplatePicker.value }
    }
    if (executionMode) {
      if (!submittedValue) {
        setSlashSubmitError(t('workbench.execution_mode_prompt_required'))
        return
      }
      if (executionMode === 'orchestrate' && !canSelectOrchestrate) {
        setSlashSubmitError(t('workbench.orchestrate_before_first_message'))
        return
      }
      if (executionMode === 'moa-plan' && controls.attachments.length > 0) {
        setSlashSubmitError(t('workbench.moa_plan_text_only'))
        return
      }
      const submittedDraft = executionDraft
      const submittedQuery = modeQueryRef.current
      options = {
        ...options,
        ...(executionMode === 'orchestrate'
          ? { sessionMode: 'orchestrate' }
          : { turnMode: executionMode }),
        guideWhenBusy: false,
        onExecutionModeAccepted: () => {
          if (modeQueryRef.current === submittedQuery) modeQueryRef.current += 1
          setExecutionDraft(current => (current === submittedDraft ? null : current))
        },
      }
    }
    if (queuePaused && queuedMessages.length > 0 && submittedValue) {
      setPendingQueuedSend({ valueOverride, options })
      return
    }
    if (options === undefined) {
      void onSubmit(valueOverride)
      return
    }
    void onSubmit(valueOverride, options)
  }

  const sendWithQueue = (clearQueue: boolean) => {
    if (!pendingQueuedSend) return
    const { valueOverride, options } = pendingQueuedSend
    setPendingQueuedSend(null)
    if (clearQueue) {
      onClearQueue?.()
      void onSubmit(valueOverride, options)
      return
    }
    if (onResumeQueueWithInput) {
      onChange('')
      void onResumeQueueWithInput(valueOverride, options)
      return
    }
    void Promise.resolve(onSubmit(valueOverride, options)).finally(() => onResumeQueue?.())
  }

  const composerProps = {
    executionModes,
    value,
    onChange: (nextValue: string) => {
      setSlashSubmitError(null)
      onChange(nextValue)
    },
    onSubmit: handleSubmit,
    disabled,
    submitDisabled,
    disabledReason,
    placeholder: disabledReason ? '' : inputPlaceholder,
    onOpenSkillFile,
    workspaceTarget,
    workspaceFileApi,
    cloudMentionCandidates,
    conversationMentionCandidates,
    cloudProjectCandidates,
    cloudSpaceEnabled,
    onSelectCloudProject,
  }
  const displayedError = slashSubmitError ?? error
  const settingsTemplateSelect = settingsTemplatePicker ? (
    <SettingsSelect
      density="compact"
      icon={<Layers />}
      data-testid="chat-settings-template"
      aria-label={t('configTemplates.sessionChoice')}
      value={settingsTemplatePicker.value ?? ''}
      onChange={event => settingsTemplatePicker.onChange(event.target.value || undefined)}
    >
      <option value="">{settingsTemplatePicker.placeholder}</option>
      {settingsTemplatePicker.options.map(option => (
        <option key={option.id} value={option.id}>
          {option.isDefault ? `${option.name} ★` : option.name}
        </option>
      ))}
    </SettingsSelect>
  ) : null
  const settingsTemplateBadgeChip = settingsTemplateBadge ? (
    <div
      data-testid="chat-settings-template-badge"
      data-status={settingsTemplateBadge.status}
      className="flex min-w-0 items-center gap-1 rounded-md border border-border px-1 py-0.5 text-xs text-text-secondary"
      title={t(
        settingsTemplateBadge.status === 'missing'
          ? 'configTemplates.boundMissing'
          : settingsTemplateBadge.status === 'drifted'
            ? 'configTemplates.boundDrifted'
            : 'configTemplates.boundCurrent',
        { name: settingsTemplateBadge.name }
      )}
    >
      <span className="max-w-[10rem] truncate">{settingsTemplateBadge.name}</span>
      {settingsTemplateBadge.status !== 'current' && <span aria-hidden>!</span>}
    </div>
  ) : null
  const executionModePill =
    executionMode || sessionMode === 'orchestrate' ? (
      <div className="flex min-w-0 items-center gap-1" data-testid="execution-mode-footer">
        <ComposerModePill
          label={`/${executionMode ?? 'orchestrate'}`}
          testId="execution-mode-draft"
          className="min-w-0 shrink font-normal [&>span]:truncate"
          onCancel={
            executionMode
              ? () => {
                  modeQueryRef.current += 1
                  setExecutionDraft(null)
                  setModeInfo(null)
                }
              : undefined
          }
          cancelLabel={t('workbench.execution_mode_cancel')}
          title={t(
            executionMode === 'orchestrate'
              ? 'workbench.orchestrate_before_first_message'
              : 'workbench.execution_mode_next_turn'
          )}
        />
        {executionMode && modeInfo?.scope === executionScope && (
          <ExecutionModeInfo text={modeInfo.text} />
        )}
      </div>
    ) : null
  const errorBanner = displayedError ? (
    <div
      className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      data-testid="chat-input-error"
      role="alert"
    >
      {displayedError}
    </div>
  ) : null
  const queuePanel = (
    <ConversationQueuePanel
      queuedMessages={queuedMessages}
      guidanceMessages={guidanceMessages}
      onCancelQueuedMessage={onCancelQueuedMessage}
      onSendQueuedAsGuidance={onSendQueuedAsGuidance}
      onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
      onEditQueuedMessage={onEditQueuedMessage}
      onReorderQueuedMessages={onReorderQueuedMessages}
      queuePaused={queuePaused}
      onResumeQueue={onResumeQueue}
      onCancelGuidanceMessage={onCancelGuidanceMessage}
    />
  )
  const queueResumeDialog = pendingQueuedSend ? (
    <QueueResumeDialog
      t={tChat}
      onCancel={() => setPendingQueuedSend(null)}
      onPreserve={() => sendWithQueue(false)}
      onClear={() => sendWithQueue(true)}
    />
  ) : null
  const modelSwitchWarningDialog = pendingModelSelection ? (
    <ModelSwitchWarningDialog
      t={t}
      targetModelLabel={
        pendingModelSelection.model?.displayName ||
        pendingModelSelection.model?.name ||
        t('workbench.model_auto_select', 'Auto select')
      }
      onCancel={() => setPendingModelSelection(null)}
      onConfirm={confirmModelSelection}
    />
  ) : null

  if (variant === 'desktop') {
    return (
      <div className="w-full">
        <TaskPlanProgress plan={taskPlan} />
        {queuePanel}
        {errorBanner}
        <PluginTrialTemplateStrip templates={controls.trialTemplates ?? []} />
        {displayedGoal && !goalDraftActive && (
          <GoalStatusBar
            goal={displayedGoal}
            continuing={goalContinuing}
            onEditGoal={onEditGoal}
            onPauseGoal={onPauseGoal}
            onResumeGoal={onResumeGoal}
            onClearGoal={onClearGoal}
          />
        )}
        <ProjectChatComposer
          {...composerProps}
          models={controls.models}
          selectedModel={controls.selectedModel}
          activeModel={controls.activeModel}
          selectedModelOptions={controls.selectedModelOptions}
          modelSelectorOpenSignal={controls.modelSelectorOpenSignal}
          onModelSelectorOpenChange={controls.onModelSelectorOpenChange}
          isModelSelectionReady={controls.isModelSelectionReady ?? true}
          attachments={controls.attachments}
          codeComments={codeComments}
          uploadingFiles={controls.uploadingFiles}
          onCancelUpload={controls.cancelUpload}
          attachmentErrors={controls.errors}
          contextUsage={controls.contextUsage}
          onSelectModel={model => requestModelSelection(model)}
          onSelectModelAndOptions={(model, options) => requestModelSelection(model, options)}
          onSelectModelOption={controls.setSelectedModelOption}
          onBlockedModelSelect={controls.onBlockedModelSelect}
          onFileSelect={files => {
            void controls.handleFileSelect(files)
          }}
          planModeActive={planModeActive}
          onSetPlanMode={selectPlanMode}
          onClearPlanMode={handleClearPlanMode}
          onSetGoal={selectGoal}
          onCompactContext={handleCompactContext}
          goalDraftActive={goalDraftActive}
          goalDraftMode={goalDraftMode}
          onCancelGoalDraft={onCancelGoalDraft}
          onRemoveAttachment={attachmentId => {
            void controls.removeAttachment(attachmentId)
          }}
          onClearCodeComments={onClearCodeComments}
          projectWork={
            projectWork ?? {
              projects: [],
              devices: [],
              runtimeWork: null,
              currentProject: null,
              currentProjectId: undefined,
              currentStandaloneDeviceId: null,
              selectedDeviceWorkspaceId: null,
              pendingProjectWorkspaceProjectId: null,
              executionMode: 'current_workspace',
              executionModeLocked: false,
              onSelectProject: () => {},
              onSelectStandaloneDevice: () => {},
              onSelectProjectWorkspace: () => {},
              onBindProjectWorkspace: () => {},
              onExecutionModeChange: () => {},
              onCreateProjectMode: undefined,
            }
          }
          showProjectWorkBar={showProjectWorkBar}
          onListLocalSkills={controls.listLocalSkills}
          onListLocalApps={controls.listLocalApps}
          isStreaming={isStreaming}
          onPause={onPause}
          onShortenWait={onShortenWait}
          shortenWaitAvailable={shortenWaitAvailable}
          toolbarLeadingContext={toolbarLeadingContext}
          modeStatus={
            <>
              {settingsTemplateSelect}
              {settingsTemplateBadgeChip}
              {executionModePill}
            </>
          }
        />
        {queueResumeDialog}
        {modelSwitchWarningDialog}
      </div>
    )
  }

  return (
    <div className="w-full">
      <TaskPlanProgress plan={taskPlan} />
      {queuePanel}
      {errorBanner}
      <PluginTrialTemplateStrip templates={controls.trialTemplates ?? []} />
      {displayedGoal && !goalDraftActive && (
        <GoalStatusBar
          goal={displayedGoal}
          continuing={goalContinuing}
          onEditGoal={onEditGoal}
          onPauseGoal={onPauseGoal}
          onResumeGoal={onResumeGoal}
          onClearGoal={onClearGoal}
        />
      )}
      <CompactChatComposer
        {...composerProps}
        attachments={controls.attachments}
        codeComments={codeComments}
        uploadingFiles={controls.uploadingFiles}
        onCancelUpload={controls.cancelUpload}
        attachmentErrors={controls.errors}
        onFileSelect={files => {
          void controls.handleFileSelect(files)
        }}
        planModeActive={planModeActive}
        onSetPlanMode={selectPlanMode}
        onClearPlanMode={handleClearPlanMode}
        onSetGoal={selectGoal}
        onCompactContext={handleCompactContext}
        goalDraftActive={goalDraftActive}
        goalDraftMode={goalDraftMode}
        onSelectModelOption={controls.setSelectedModelOption}
        onCancelGoalDraft={onCancelGoalDraft}
        onRemoveAttachment={attachmentId => {
          void controls.removeAttachment(attachmentId)
        }}
        onClearCodeComments={onClearCodeComments}
        onListLocalSkills={controls.listLocalSkills}
        onListLocalApps={controls.listLocalApps}
        models={controls.models}
        selectedModel={controls.selectedModel}
        activeModel={controls.activeModel}
        selectedModelOptions={controls.selectedModelOptions}
        onSelectModel={model => requestModelSelection(model)}
        onBlockedModelSelect={controls.onBlockedModelSelect}
        isModelSelectionReady={controls.isModelSelectionReady ?? true}
        isStreaming={isStreaming}
        onPause={onPause}
        modeStatus={
          <>
            {settingsTemplateSelect}
            {settingsTemplateBadgeChip}
            {executionModePill}
          </>
        }
      />
      {queueResumeDialog}
      {modelSwitchWarningDialog}
    </div>
  )
}

function conversationMentionCandidate(
  candidate: ConversationMentionCandidate,
  t: ReturnType<typeof useTranslation>['t']
) {
  const workspaceLabel =
    candidate.projectName || candidate.address.workspacePath || candidate.address.deviceId
  return {
    kind: 'conversation' as const,
    key: candidate.key,
    title: candidate.title,
    description: workspaceLabel,
    metaLabel: t('workbench.mention_conversation', 'Conversation'),
    testId: candidate.testId,
    enabled: true,
    reference: candidate.reference,
    searchAliases: [
      candidate.title,
      candidate.projectName ?? '',
      candidate.address.workspacePath ?? '',
    ],
    conversation: candidate,
  }
}

function QueueResumeDialog({
  t,
  onCancel,
  onPreserve,
  onClear,
}: {
  t: (key: string) => string
  onCancel: () => void
  onPreserve: () => void
  onClear: () => void
}) {
  return (
    <div
      data-testid="paused-queue-send-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paused-queue-send-dialog-title"
        data-testid="paused-queue-send-dialog"
        className="w-full max-w-[360px] rounded-lg border border-border bg-popover p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
      >
        <h2
          id="paused-queue-send-dialog-title"
          className="text-base font-semibold text-text-primary"
        >
          {t('queue.send_with_paused_title')}
        </h2>
        <p className="mt-1.5 text-sm leading-5 text-text-secondary">
          {t('queue.send_with_paused_description')}
        </p>
        <div className="mt-4 flex justify-end gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="paused-queue-send-cancel-button"
            onClick={onCancel}
            className="h-8 rounded-md border-border bg-base px-3 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('queue.send_with_paused_cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="paused-queue-send-clear-button"
            onClick={onClear}
            className="h-8 rounded-md border-red-200 bg-base px-3 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            {t('queue.send_with_paused_clear')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="paused-queue-send-preserve-button"
            onClick={onPreserve}
            className="h-8 rounded-md border-text-primary bg-text-primary px-3 text-xs text-background hover:bg-text-primary/90 hover:text-background"
          >
            {t('queue.send_with_paused_preserve')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModelSwitchWarningDialog({
  t,
  targetModelLabel,
  onCancel,
  onConfirm,
}: {
  t: ReturnType<typeof useTranslation>['t']
  targetModelLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      data-testid="model-switch-warning-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-switch-warning-dialog-title"
        aria-describedby="model-switch-warning-dialog-description"
        data-testid="model-switch-warning-dialog"
        className="w-full max-w-[400px] rounded-2xl border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.24)]"
      >
        <h2 id="model-switch-warning-dialog-title" className="heading-small text-text-primary">
          {t('workbench.model_switch_warning_title', 'Switch model?')}
        </h2>
        <p
          id="model-switch-warning-dialog-description"
          className="mt-2 text-sm leading-5 text-text-secondary"
        >
          {t(
            'workbench.model_switch_warning_description',
            'Switching to {{model}} may change how the existing context is understood. Tool support, response style, and task continuity may also differ.',
            { model: targetModelLabel }
          )}
        </p>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.model_switch_warning_effect',
            'The new model will be used for the next message. If a response is in progress, it will continue with the current model.'
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="model-switch-warning-cancel-button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('workbench.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="model-switch-warning-confirm-button"
            onClick={onConfirm}
            className="h-8 rounded-lg bg-text-primary px-4 text-sm text-background hover:bg-text-primary/90"
          >
            {t('workbench.model_switch_warning_confirm', 'Switch model')}
          </Button>
        </div>
      </div>
    </div>
  )
}
