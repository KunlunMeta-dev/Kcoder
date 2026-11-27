import { AtSign, CircleHelp, ClipboardList, Cpu, FileArchive, Package, Plug, Shrink, Target } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useTransientNotice } from '@/hooks/useTransientNotice'
import { FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT } from '@/features/plugins/pluginTrial'
import { isImeComposingEvent, isImeEnterEvent } from '@/lib/ime'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import {
  canOpenNativeWorkspacePathPicker,
  openNativeWorkspacePathPicker,
  type NativeWorkspacePath,
} from '@/lib/native-workspace-path-picker'
import { resolveDataTransferWorkspacePaths } from '@/lib/workspace-path-transfer'
import { runtimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import type { LocalDeviceSkill, UnifiedModel } from '@/types/api'
import {
  ComposerProseMirrorEditor,
  type ComposerEditorHandle,
  type ComposerEditorSnapshot,
} from './ComposerProseMirrorEditor'
import type { ComposerTextTrigger, SlashCommand } from './composerAutocomplete'
import {
  chooseNearestTrigger,
  filterSlashCommands,
  findStandaloneTrigger,
  hasDraftTextForSlashCommands,
  parseComposerSlashInput,
  parseCloudProjectScopeQuery,
  SlashCommandInputError,
} from './composerAutocomplete'
import { kcoderBuiltinSlashNames } from './slashCatalog'
import {
  matchesMentionQuery,
  isMentionMenuRowEnabled,
  type MentionMenuRow,
  skillBelongsToPlugin,
  type ComposerPluginMentionCandidate,
  slashAppTestId,
  slashSkillTestId,
  type ComposerMentionCandidate,
} from './composerMentionCandidates'
import {
  createComposerPathReference,
  findComposerMentionDeletionRange,
  replaceComposerMentionTrigger,
  resolveComposerWorkspacePath,
} from './composerMentions'
import { workspacePathReferenceText } from './composerPathTransfer'
import { createLongPastedTextAttachment } from './pastedTextAttachment'
import { SlashCommandMenu } from './SlashCommandMenu'
import { SlashModelMenu } from './SlashModelMenu'
import { debugComposerEvent, textMetrics } from './composerDebug'
import { ComposerMentionMenu } from './ComposerMentionMenu'
import { useWorkspaceMentionSearch } from './useWorkspaceMentionSearch'
import { useComposerMentionCandidates } from './useComposerMentionCandidates'
import type { ComposerTextareaProps } from './composerTextareaTypes'
import { ComposerInputHistory } from './composerInputHistory'
import { useComposerDirectory } from './useComposerDirectory'
import { useRetainedPageVisible } from '@/components/layout/retainedPageState'
import { TOOLS_CATALOG_INVALIDATED_EVENT, toolsCatalogChangeApplies } from '@/kcoder/toolsCatalogEvents'

export type { ComposerSubmitOptions } from './composerTextareaTypes'

interface ActiveComposerMenu {
  kind: ComposerTextTrigger['kind']
  trigger: ComposerTextTrigger
}

export function ComposerTextarea({
  textOnly = false,
  value,
  inputHistory = [],
  inputHistoryScope,
  onChange,
  onSubmit,
  slashSubmitRef,
  slashActions,
  contextUsage,
  canSend,
  disabled,
  placeholder,
  testId = 'chat-message-input',
  rows,
  textareaRef,
  className,
  skillMenuClassName = 'left-0 w-[min(28rem,calc(100vw-2rem))] max-w-full',
  onPasteFiles,
  onOpenSkillFile,
  workspaceTarget,
  workspaceFileApi,
  cloudMentionCandidates = [],
  conversationMentionCandidates = [],
  cloudProjectCandidates = [],
  cloudSpaceEnabled = false,
  onSelectCloudProject,
  onListLocalSkills,
  onListLocalApps,
  onListLocalPlugins,
  models = [],
  selectedModel,
  selectedModelOptions = {},
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  executionModes,
  onCompactContext,
  onSelectModel,
  onBlockedModelSelect,
  isModelSelectionReady = true,
}: ComposerTextareaProps) {
  const { t } = useTranslation('common')
  const [slashCommandError, setSlashCommandError] = useState<string | null>(null)
  const [slashNotice, setSlashNotice] = useState<{ scope: string; message: string } | null>(null)
  // Slash results and errors are transient overlays: they fade after a delay
  // unless the pointer or focus is on them, and never take layout space.
  const [slashOverlayHeld, setSlashOverlayHeld] = useState(false)
  const slashErrorNotice = useMemo(
    () => (slashCommandError === null ? null : { message: slashCommandError }),
    [slashCommandError]
  )
  const clearSlashNotice = useCallback(
    (notice: { scope: string; message: string }) =>
      setSlashNotice(current => (current === notice ? null : current)),
    []
  )
  const clearSlashError = useCallback(
    (notice: { message: string }) =>
      setSlashCommandError(current => (current === notice.message ? null : current)),
    []
  )
  const slashNoticeFading = useTransientNotice(slashNotice, clearSlashNotice, slashOverlayHeld)
  const slashErrorFading = useTransientNotice(slashErrorNotice, clearSlashError, slashOverlayHeld)
  const slashOverlayHoldProps = {
    onMouseEnter: () => setSlashOverlayHeld(true),
    onMouseLeave: () => setSlashOverlayHeld(false),
    onFocus: () => setSlashOverlayHeld(true),
    onBlur: () => setSlashOverlayHeld(false),
  }
  const slashScope = JSON.stringify([inputHistoryScope, workspaceTarget?.deviceId, workspaceTarget?.path])
  const slashScopeRef = useRef(slashScope)
  useLayoutEffect(() => {
    slashScopeRef.current = slashScope
  }, [slashScope])
  const runningSlashRef = useRef<{ scope: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ComposerEditorHandle | null>(null)
  const valueRef = useRef(value)
  const inputHistoryRef = useRef({
    scope: inputHistoryScope,
    navigation: new ComposerInputHistory(),
  })
  const activeMenuRef = useRef<ActiveComposerMenu | null>(null)
  const highlightedIndexRef = useRef(0)
  const showSkillMenuRef = useRef(false)
  const showSlashMenuRef = useRef(false)
  const activeOptionCountRef = useRef(0)
  const suppressEnterUntilKeyUpRef = useRef(false)
  const suppressEscapeAutocompleteKeyUpRef = useRef(false)
  const [isComposing, setIsComposing] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const [activeMenu, setActiveMenu] = useState<ActiveComposerMenu | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0)
  const [cloudProjectsOpen, setCloudProjectsOpen] = useState(false)
  const [pluginSkills, setPluginSkills] = useState<ComposerPluginMentionCandidate | null>(null)
  const visible = useRetainedPageVisible()
  const menuActive = visible && !textOnly && activeMenu !== null
  const directoryActive = menuActive || (visible && !textOnly && Boolean(parseComposerSlashInput(value)?.args))
  const skillSource = useComposerDirectory(onListLocalSkills, directoryActive)
  const appSource = useComposerDirectory(onListLocalApps, directoryActive)
  const pluginSource = useComposerDirectory(onListLocalPlugins, menuActive && activeMenu?.kind !== 'slash')
  const { items: skills, loading, error: loadError, retry: retrySkills } = skillSource
  const { retry: retryPlugins } = pluginSource
  const { items: apps, loading: appsLoading, error: appsLoadError } = appSource
  const retryLocalMentions = () => { retrySkills(); appSource.retry() }
  const canPickNativeWorkspacePaths =
    canOpenNativeWorkspacePathPicker() && workspaceTarget?.workspaceSource !== 'remote'

  useEffect(() => {
    const invalidate = (event: Event) => {
      if (!toolsCatalogChangeApplies(event, workspaceTarget?.deviceId)) return
      retrySkills()
      retryPlugins()
    }
    window.addEventListener(TOOLS_CATALOG_INVALIDATED_EVENT, invalidate)
    return () => window.removeEventListener(TOOLS_CATALOG_INVALIDATED_EVENT, invalidate)
  }, [retrySkills, retryPlugins, workspaceTarget?.deviceId])

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const { appCandidates, skillCandidates, mentionCandidates, filteredMentionCandidates } =
    useComposerMentionCandidates(
      apps,
      skills,
      selectedModel,
      activeMenu?.kind === 'skill' || activeMenu?.kind === 'mention'
        ? activeMenu.trigger.query
        : '',
      cloudMentionCandidates,
      conversationMentionCandidates,
      pluginSource.items
    )

  const workspaceSearch = useWorkspaceMentionSearch(
    menuActive && activeMenu?.kind === 'mention' ? activeMenu.trigger.query : '',
    workspaceTarget,
    workspaceFileApi
  )

  // The localized `@project-space:keyword` scope syntax drills straight into the cloud project
  // list without clicking the menu entry, matching the other mention flows.
  const cloudProjectScopeLabels = useMemo(
    () => [
      t('workbench.mention_cloud_project_space', '项目空间'),
      '项目空间',
      'project space',
      'project-space',
    ],
    [t]
  )
  const cloudProjectScopeLabelsRef = useRef(cloudProjectScopeLabels)
  useEffect(() => {
    cloudProjectScopeLabelsRef.current = cloudProjectScopeLabels
  }, [cloudProjectScopeLabels])
  const cloudProjectScopeKeyword =
    activeMenu?.kind === 'mention'
      ? parseCloudProjectScopeQuery(activeMenu.trigger.query, cloudProjectScopeLabels)
      : null
  const cloudProjectScopeActive = cloudSpaceEnabled && cloudProjectScopeKeyword !== null
  const filteredCloudProjectCandidates = useMemo(
    () =>
      cloudProjectScopeActive
        ? cloudProjectCandidates.filter(candidate =>
            matchesMentionQuery(candidate, cloudProjectScopeKeyword ?? '')
          )
        : cloudProjectCandidates,
    [cloudProjectCandidates, cloudProjectScopeActive, cloudProjectScopeKeyword]
  )
  // The direct cloud-space token inserted by the localized project-space row. Selecting it
  // never binds a project; it just tags the message with the generic
  // `cloud://projects` capability reference.
  const cloudSpaceDirectReference = `[$${t('workbench.mention_cloud_project_space', '项目空间')}](cloud://projects)`

  const canOpenSlashModelMenu = isModelSelectionReady && Boolean(onSelectModel) && models.length > 0
  const openSlashModelMenu = useCallback(() => {
    setModelQuery('')
    setModelSelectedIndex(0)
    setModelMenuOpen(true)
  }, [])
  const closeSlashModelMenu = useCallback(
    (focusTextarea = false) => {
      setModelMenuOpen(false)
      setModelQuery('')
      setModelSelectedIndex(0)
      if (focusTextarea) {
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus()
        })
      }
    },
    [textareaRef]
  )

  const actionSlashCommands = useMemo<SlashCommand[]>(() => {
    const commands: SlashCommand[] = []

    if (onSetPlanMode && !planModeActive) {
      commands.push({
        id: 'plan',
        title: '/plan',
        description: t('workbench.slash_command_plan_description'),
        searchAliases: ['plan', 'plan mode', 'planning'],
        Icon: ClipboardList,
        testId: 'plan',
        acceptsArguments: true,
        onSelect: onSetPlanMode,
      })
    }

    if (onClearPlanMode && planModeActive) {
      commands.push({
        id: 'unplan',
        title: '/unplan',
        description: t('workbench.slash_command_unplan_description'),
        Icon: ClipboardList,
        testId: 'unplan',
        onSelect: onClearPlanMode,
      })
    }

    if (onSetGoal) {
      commands.push({
        id: 'goal',
        title: '/goal',
        description: t('workbench.slash_command_goal_description'),
        searchAliases: ['goal', 'target', 'objective'],
        Icon: Target,
        testId: 'goal',
        acceptsArguments: true,
        onSelect: () => onSetGoal('standard'),
      })
      commands.push({
        id: 'goal-pro',
        title: '/goal-pro',
        description: t('workbench.slash_command_goal_pro_description'),
        searchAliases: ['goal pro', 'strict goal', 'verified goal'],
        Icon: Target,
        testId: 'goal-pro',
        acceptsArguments: true,
        onSelect: () => onSetGoal('strict'),
      })
    }

    if (executionModes) {
      for (const mode of ['orchestrate', 'moa', 'moa-plan'] as const) {
        if (mode === 'orchestrate' && !executionModes.canSelectOrchestrate) continue
        commands.push({
          id: mode,
          title: `/${mode}`,
          description: t(`workbench.slash_command_${mode.replace('-', '_')}_description`),
          searchAliases: [mode],
          Icon: ClipboardList,
          testId: mode,
          acceptsArguments: mode !== 'orchestrate',
          onSelect: () => executionModes.onSelect(mode),
        })
      }
    }

    if (onCompactContext) {
      commands.push({
        id: 'compact',
        title: '/compact',
        description: t('workbench.slash_command_compact_description'),
        searchAliases: ['compact', 'context compaction'],
        requiresEmptyComposer: true,
        Icon: Shrink,
        testId: 'compact',
        onSelect: onCompactContext,
      })
    }

    if (canOpenSlashModelMenu) {
      commands.push({
        id: 'model',
        title: '/model',
        description: t('workbench.slash_command_model_description'),
        searchAliases: ['model', 'model selector'],
        Icon: Cpu,
        testId: 'model',
        usage: '/model [name | info]',
        acceptsArguments: true,
        onSelect: openSlashModelMenu,
      })
    }

    if (workspaceTarget || cloudSpaceEnabled) {
      commands.push({
        id: 'mention', title: '/mention', Icon: AtSign, testId: 'mention',
        description: t('workbench.slash_command_mention_description'),
      })
    }
    if (onListLocalSkills) {
      commands.push({
        id: 'skill', title: '/skill', Icon: Package, testId: 'skill',
        description: t('workbench.slash_command_skill_description'),
        usage: '/skill <name> [instructions]',
        acceptsArguments: true,
        matchesArguments: args => !args.startsWith('-'),
      })
      commands.push({
        id: 'skills', title: '/skills', Icon: Package, testId: 'skills',
        description: t('workbench.slash_commands.skills'),
        requiresEmptyComposer: true,
        run: () => skillCandidates.filter(candidate => candidate.enabled).map(candidate => candidate.skill.name).join('\n') ||
          t('workbench.slash_no_skills'),
      })
    }
    if (onListLocalApps) {
      commands.push({
        id: 'apps', title: '/apps', Icon: Plug, testId: 'apps',
        description: t('workbench.slash_commands.apps'),
        requiresEmptyComposer: true,
        run: () => appCandidates.filter(candidate => candidate.enabled).map(candidate => candidate.title).join('\n') ||
          t('workbench.slash_no_apps'),
      })
    }

    if (onSetPlanMode || onClearPlanMode) {
      commands.push({
        id: 'planstatus',
        title: '/planstatus',
        description: t('workbench.slash_command_planstatus_description'),
        Icon: ClipboardList,
        testId: 'planstatus',
        requiresEmptyComposer: true,
        run: () => t(planModeActive ? 'workbench.slash_plan_active' : 'workbench.slash_plan_inactive'),
      })
    }

    const metrics = contextUsage && runtimeContextUsageMetrics(contextUsage)
    if (metrics) {
      const used = metrics.usedTokens.toLocaleString()
      const total = metrics.totalTokens.toLocaleString()
      commands.push({
        id: 'context',
        title: '/context',
        aliases: ['/ctx'],
        searchAliases: ['ctx'],
        description: t('workbench.slash_command_context_description'),
        Icon: FileArchive,
        testId: 'context',
        requiresEmptyComposer: true,
        run: () => t(
          'workbench.slash_context_usage',
          `The current context uses ${used} of ${total} tokens.`,
          { used, total }
        ),
      })
    }

    commands.push({
      id: 'help',
      title: '/help',
      aliases: ['/?'],
      searchAliases: ['?'],
      description: t('workbench.slash_command_help_description'),
      Icon: CircleHelp,
      testId: 'help',
      requiresEmptyComposer: true,
    })
    return [...commands, ...(slashActions ?? [])]
  }, [
    appCandidates,
    canOpenSlashModelMenu,
    cloudSpaceEnabled,
    contextUsage,
    onCompactContext,
    onClearPlanMode,
    onSetGoal,
    executionModes,
    onSetPlanMode,
    onListLocalSkills,
    onListLocalApps,
    openSlashModelMenu,
    planModeActive,
    skillCandidates,
    slashActions,
    t,
    workspaceTarget,
  ])

  const skillSlashCommands = useMemo<SlashCommand[]>(() => {
    const skillGroup = t('workbench.slash_command_group_skills')
    return skillCandidates.map(candidate => ({
      id: candidate.key,
      title: candidate.title,
      aliases: [`/${candidate.skill.name.toLowerCase()}`],
      description: candidate.description,
      metaLabel: candidate.metaLabel,
      group: skillGroup,
      searchAliases: candidate.searchAliases,
      Icon: Package,
      enabled: candidate.enabled,
      testId: slashSkillTestId(candidate.skill.name),
      skill: candidate.skill,
    }))
  }, [skillCandidates, t])

  const appSlashCommands = useMemo<SlashCommand[]>(() => {
    const appGroup = t('workbench.slash_command_group_apps', 'Apps')
    return appCandidates.map(candidate => ({
      id: candidate.key,
      title: candidate.title,
      description: candidate.description,
      metaLabel: candidate.metaLabel,
      group: appGroup,
      searchAliases: candidate.searchAliases,
      Icon: Plug,
      enabled: candidate.enabled,
      testId: slashAppTestId(candidate.app.id),
      app: candidate.app,
    }))
  }, [appCandidates, t])

  const slashCommands = useMemo(
    () => [...actionSlashCommands.filter((command, index) =>
      actionSlashCommands.findIndex(candidate => candidate.title === command.title ||
        candidate.aliases?.includes(command.title)) === index
    ), ...skillSlashCommands, ...appSlashCommands].filter(command =>
      !kcoderBuiltinSlashNames.has(command.title) || (!command.skill && !command.app)
    ),
    [actionSlashCommands, appSlashCommands, skillSlashCommands]
  )

  const filteredSlashCommands = useMemo(() => {
    if (activeMenu?.kind !== 'slash') return []
    return filterSlashCommands(
      slashCommands,
      activeMenu.trigger.query,
      hasDraftTextForSlashCommands(value)
    )
  }, [activeMenu, slashCommands, value])

  const showSkillMenu =
    (activeMenu?.kind === 'skill' || activeMenu?.kind === 'mention') &&
    (activeMenu.kind === 'mention' || Boolean(onListLocalSkills) || Boolean(onListLocalApps) || Boolean(onListLocalPlugins))
  const showSlashMenu = activeMenu?.kind === 'slash'
  const mentionMenuRows = useMemo<MentionMenuRow[]>(() => {
    if (!showSkillMenu) return []
    if (pluginSkills && pluginSource.items.includes(pluginSkills.plugin)) {
      return [
        { kind: 'plugin-back-action' },
        ...skillCandidates
          .filter(
            candidate =>
              skillBelongsToPlugin(pluginSkills.plugin, candidate.skill) &&
              matchesMentionQuery(candidate, activeMenu?.trigger.query ?? '')
          )
          .map(candidate => ({ kind: 'candidate', candidate }) as MentionMenuRow),
      ]
    }
    const withPluginSkills = (candidates: ComposerMentionCandidate[]): MentionMenuRow[] =>
      candidates.flatMap(candidate => [
        { kind: 'candidate', candidate },
        ...(candidate.kind === 'plugin' &&
        skillCandidates.some(skill => skillBelongsToPlugin(candidate.plugin, skill.skill))
          ? [{ kind: 'plugin-skills-action', plugin: candidate } as MentionMenuRow]
          : []),
      ])
    if (activeMenu?.kind === 'skill') {
      return withPluginSkills(filteredMentionCandidates)
    }
    if (!activeMenu?.trigger.query.trim()) {
      const nonCloudCandidates = filteredMentionCandidates.filter(
        candidate => candidate.kind !== 'cloud'
      )
      if (cloudProjectsOpen && cloudProjectCandidates.length > 0) {
        return [
          { kind: 'cloud-back-action' },
          ...cloudProjectCandidates.map(
            candidate => ({ kind: 'candidate', candidate }) as MentionMenuRow
          ),
        ]
      }
      return [
        { kind: 'files-action' },
        ...(onSetGoal ? ([{ kind: 'goal-action' }] as MentionMenuRow[]) : []),
        ...(!planModeActive && onSetPlanMode
          ? ([{ kind: 'plan-action' }] as MentionMenuRow[])
          : []),
        ...(cloudSpaceEnabled ? ([{ kind: 'cloud-space-direct-action' }] as MentionMenuRow[]) : []),
        ...(cloudSpaceEnabled && cloudProjectCandidates.length > 0
          ? ([{ kind: 'cloud-projects-action' }] as MentionMenuRow[])
          : []),
        ...withPluginSkills(nonCloudCandidates),
      ]
    }
    if (cloudProjectScopeActive) {
      return [
        { kind: 'cloud-space-direct-action' },
        ...filteredCloudProjectCandidates.map(
          candidate => ({ kind: 'candidate', candidate }) as MentionMenuRow
        ),
      ]
    }
    return [
      ...withPluginSkills(filteredMentionCandidates),
      ...workspaceSearch.matches.map(item => ({ kind: 'path', item }) as MentionMenuRow),
    ]
  }, [
    activeMenu,
    cloudProjectCandidates,
    cloudProjectScopeActive,
    cloudProjectsOpen,
    cloudSpaceEnabled,
    filteredCloudProjectCandidates,
    filteredMentionCandidates,
    onSetGoal,
    onSetPlanMode,
    planModeActive,
    showSkillMenu,
    pluginSkills,
    pluginSource.items,
    skillCandidates,
    workspaceSearch.matches,
  ])
  const activeOptionCount = showSkillMenu
    ? mentionMenuRows.length
    : showSlashMenu
      ? filteredSlashCommands.length
      : 0
  const enabledOptionIndices = useMemo(
    () => (showSkillMenu
      ? mentionMenuRows.map(row => isMentionMenuRowEnabled(row, canPickNativeWorkspacePaths))
      : filteredSlashCommands.map(command => command.enabled !== false))
      .flatMap((enabled, index) => enabled ? [index] : []),
    [showSkillMenu, mentionMenuRows, canPickNativeWorkspacePaths, filteredSlashCommands]
  )
  const highlightedIndex = enabledOptionIndices.find(index => index >= selectedIndex) ??
    enabledOptionIndices.at(-1) ?? -1
  const hasMentionCandidates = mentionCandidates.length > 0
  const hasMentionLoadError = !hasMentionCandidates && (loadError || appsLoadError || pluginSource.error)
  const isMentionLoading = !hasMentionCandidates && (loading || appsLoading || pluginSource.loading)
  const hasMentionSlashCommands = skillSlashCommands.length + appSlashCommands.length > 0
  const hasSlashMentionLoadError =
    !hasMentionSlashCommands && ((Boolean(onListLocalSkills) && loadError) || appsLoadError)
  const isSlashMentionLoading =
    !hasMentionSlashCommands && ((Boolean(onListLocalSkills) && loading) || appsLoading)

  useLayoutEffect(() => {
    activeMenuRef.current = activeMenu
    highlightedIndexRef.current = highlightedIndex
    showSkillMenuRef.current = showSkillMenu
    showSlashMenuRef.current = showSlashMenu
    activeOptionCountRef.current = activeOptionCount
  }, [activeMenu, activeOptionCount, highlightedIndex, showSkillMenu, showSlashMenu])

  useEffect(() => {
    if (!showSkillMenu && !showSlashMenu) return
    const selectedOption = menuRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]'
    )
    selectedOption?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionCount, highlightedIndex, showSkillMenu, showSlashMenu])

  const closeAutocompleteMenu = useCallback(() => {
    setActiveMenu(null)
    setPluginSkills(null)
    setSelectedIndex(0)
    highlightedIndexRef.current = 0
  }, [])

  const moveHighlightedIndex = useCallback((delta: number) => {
    if (enabledOptionIndices.length === 0) return false
    const current = enabledOptionIndices.indexOf(highlightedIndexRef.current)
    const next = enabledOptionIndices[Math.max(0, Math.min(current + delta, enabledOptionIndices.length - 1))]
    highlightedIndexRef.current = next
    setSelectedIndex(next)
    return true
  }, [enabledOptionIndices])

  const updateAutocompleteTrigger = useCallback(
    (snapshot?: ComposerEditorSnapshot) => {
      if (textOnly) return
      const editor = editorRef.current
      const current = snapshot ?? editor?.getSnapshot()
      if (!current) return
      if (inputHistoryRef.current.navigation.isBrowsing(current.value)) return

      const nextTrigger = chooseNearestTrigger([
        findStandaloneTrigger(
          current.value,
          current.selectionOffset,
          '@',
          'mention',
          // Keep the trigger alive across whitespace once the query is inside
          // the localized `@project-space keyword` scope so phrases containing a
          // project-space label keep filtering instead of closing the menu.
          query => parseCloudProjectScopeQuery(query, cloudProjectScopeLabelsRef.current) !== null
        ),
        (onListLocalSkills || onListLocalPlugins)
          ? findStandaloneTrigger(current.value, current.selectionOffset, '$', 'skill')
          : null,
        findStandaloneTrigger(current.value, current.selectionOffset, '/', 'slash'),
      ])
      const currentMenu = activeMenuRef.current
      const currentTriggerEnd = currentMenu
        ? currentMenu.trigger.start + 1 + currentMenu.trigger.query.length
        : null
      const nextTriggerEnd = nextTrigger ? nextTrigger.start + 1 + nextTrigger.query.length : null
      const triggerUnchanged =
        currentMenu &&
        nextTrigger &&
        currentMenu.kind === nextTrigger.kind &&
        currentMenu.trigger.start === nextTrigger.start &&
        currentTriggerEnd === nextTriggerEnd &&
        currentMenu.trigger.query === nextTrigger.query

      setActiveMenu(nextTrigger ? { kind: nextTrigger.kind, trigger: nextTrigger } : null)
      if (nextTrigger) {
        setModelMenuOpen(false)
        if (!triggerUnchanged) {
          setSelectedIndex(0)
          highlightedIndexRef.current = 0
          setCloudProjectsOpen(false)
        }
      }
    },
    [onListLocalSkills, onListLocalPlugins, textOnly]
  )

  const commitEditorValue = useCallback(
    (nextValue: string, nextCursor: number) => {
      const editor = editorRef.current
      valueRef.current = nextValue
      if (editor) {
        editor.setValue(nextValue, nextCursor)
      } else {
        onChange(nextValue)
      }
      window.requestAnimationFrame(() =>
        updateAutocompleteTrigger({
          value: nextValue,
          selectionOffset: nextCursor,
          selectionStart: nextCursor,
          selectionEnd: nextCursor,
        })
      )
    },
    [onChange, updateAutocompleteTrigger]
  )

  const insertPathReferences = useCallback(
    (entries: NativeWorkspacePath[]) => {
      if (entries.length === 0) return
      const editor = editorRef.current
      if (!editor) return

      const references = workspacePathReferenceText(entries)
      const current = editor.getSnapshot()
      const spacer = current.value && current.selectionOffset > 0 ? ' ' : ''
      const nextValue =
        current.value.slice(0, current.selectionOffset) +
        spacer +
        references +
        ' ' +
        current.value.slice(current.selectionOffset)
      commitEditorValue(nextValue, current.selectionOffset + spacer.length + references.length + 1)
      editor.focus()
    },
    [commitEditorValue]
  )

  const selectMentionCandidate = useCallback(
    (candidate: ComposerMentionCandidate, explicitTrigger?: ComposerTextTrigger | null) => {
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor || !candidate.enabled) return false

      const snapshot = editor.getSnapshot()
      const replacement = replaceComposerMentionTrigger(
        snapshot.value,
        candidate.reference,
        trigger.start,
        snapshot.selectionEnd
      )

      commitEditorValue(replacement.value, replacement.cursor)
      closeAutocompleteMenu()
      textareaRef.current?.focus()
      editor.focus()
      return true
    },
    [closeAutocompleteMenu, commitEditorValue, textareaRef]
  )

  const selectSkill = useCallback(
    (skill: LocalDeviceSkill, explicitTrigger?: ComposerTextTrigger | null) => {
      const skillCandidate = skillCandidates.find(candidate => candidate.skill.name === skill.name)
      return skillCandidate ? selectMentionCandidate(skillCandidate, explicitTrigger) : false
    },
    [selectMentionCandidate, skillCandidates]
  )

  const submitSlashCommand = useCallback((submittedValue: string): boolean => {
    const input = parseComposerSlashInput(submittedValue)
    if (!input || textOnly) return false
    if (disabled || isComposing || modelMenuOpen) return true
    setSlashNotice(null)

    const matches = (command: SlashCommand) =>
      command.title.toLowerCase() === input.name || command.aliases?.includes(input.name)
    const matchedActions = actionSlashCommands.filter(matches)
    const accepts = (candidate: SlashCommand) => (!input.args || candidate.acceptsArguments) &&
      (candidate.matchesArguments?.(input.args) ?? true)
    const action = matchedActions.find(candidate => candidate.enabled !== false && accepts(candidate) &&
      (!candidate.requiresArguments || input.args)) ??
      matchedActions[0]
    const registered = kcoderBuiltinSlashNames.has(input.name)
    const matchesInTarget = action || registered ? [] : [...skillSlashCommands, ...appSlashCommands].filter(matches)
    const command = action ?? matchesInTarget[0]
    if (!command && !registered && submittedValue.includes('\n')) return false
    if (input.name === '/') {
      setSlashCommandError(t('workbench.slash_command_required', 'Enter a slash command name'))
    } else if (matchesInTarget.length > 1) {
      setSlashCommandError(t('workbench.slash_command_ambiguous', { command: input.name }))
    } else if (input.name === '/ultgoal' && onSetGoal) {
      commitEditorValue(input.args, input.args.length)
      closeAutocompleteMenu()
      onSetGoal('arrangement')
    } else if (command?.enabled === false || (registered && !command)) {
      setSlashCommandError(t('workbench.slash_command_unavailable', { command: input.name }))
    } else if (!command) {
      setSlashCommandError(
        showSlashMenuRef.current && filteredSlashCommands.length > 0
          ? t('workbench.slash_command_tab_hint', 'Press Tab to activate the slash command')
          : t('workbench.slash_command_unknown', `Unknown slash command: ${input.name}`, {
              command: input.name,
            })
      )
    } else if (command.skill || command.app) {
      const candidate = command.skill
        ? skillCandidates.find(item => item.skill.name === command.skill?.name)
        : appCandidates.find(item => item.app.id === command.app?.id)
      if (candidate?.enabled) {
        const value = `${candidate.reference} ${input.args}`
        commitEditorValue(value, value.length)
        closeAutocompleteMenu()
      }
    } else if (!accepts(command)) {
      setSlashCommandError(
        t('workbench.slash_command_arguments_not_supported',
          `${command.title} does not accept arguments`, { command: command.title })
      )
    } else if (command.requiresArguments && !input.args) {
      setSlashCommandError(t('workbench.slash_command_arguments_required', { command: command.title }))
    } else if (command.id === 'mention' && !command.run) {
      commitEditorValue('@', 1)
      closeAutocompleteMenu()
    } else if (command.id === 'skill' && !command.run) {
      const [name] = input.args.split(/\s+/, 1)
      const matches = skillCandidates.filter(candidate =>
        candidate.enabled && candidate.skill.name.toLowerCase() === name.toLowerCase())
      if (!name) {
        commitEditorValue('$', 1)
        closeAutocompleteMenu()
      } else if (matches.length === 1) {
        const value = `${matches[0].reference} ${input.args.slice(name.length).trimStart()}`
        commitEditorValue(value, value.length)
        closeAutocompleteMenu()
      } else {
        setSlashCommandError(t(matches.length === 0
          ? 'workbench.slash_skill_unavailable' : 'workbench.slash_command_ambiguous', { command: name }))
      }
    } else if (command.id === 'model' && input.args && !command.run) {
      if (input.args.toLowerCase() === 'info') {
        commitEditorValue('', 0)
        closeAutocompleteMenu()
        setSlashNotice({ scope: slashScope, message: selectedModel
          ? [selectedModel.provider, selectedModel.displayName || selectedModel.name].filter(Boolean).join(' / ')
          : t('workbench.slash_model_unselected') })
      } else {
        const name = input.args.toLowerCase()
        const candidates = (models ?? []).filter(model =>
          [model.name, model.modelId, model.displayName, `${model.provider}/${model.modelId}`]
            .some(value => value?.toLowerCase() === name))
        if (candidates.length !== 1 || candidates[0].compatibilityDisabled) {
          setSlashCommandError(t(candidates.length > 1
            ? 'workbench.slash_command_ambiguous' : 'workbench.slash_model_unavailable', { command: input.args }))
        } else {
          commitEditorValue('', 0)
          closeAutocompleteMenu()
          onSelectModel?.(candidates[0])
        }
      }
    } else if (command.prompt) {
      if (!canSend) {
        setSlashCommandError(t('workbench.slash_command_unavailable', { command: input.name }))
      } else {
        closeAutocompleteMenu()
        onSubmit(command.prompt(input.args))
      }
    } else if (command.run) {
      if (runningSlashRef.current?.scope === slashScope) return true
      const draft = valueRef.current
      const running = { scope: slashScope }
      runningSlashRef.current = running
      closeAutocompleteMenu()
      setSlashCommandError(null)
      const isCurrent = () => mountedRef.current &&
        slashScopeRef.current === slashScope && valueRef.current === draft
      const run = command.run
      void Promise.resolve().then(() => isCurrent() ? run(input.args, isCurrent) : undefined).then(
        result => {
          if (!isCurrent()) return
          commitEditorValue('', 0)
          if (result) setSlashNotice({ scope: slashScope, message: result })
        },
        (error: unknown) => {
          if (isCurrent()) setSlashCommandError(error instanceof SlashCommandInputError
            ? error.message : t('workbench.slash_command_failed', { command: command.title }))
        }
      ).finally(() => {
        if (runningSlashRef.current === running) runningSlashRef.current = null
      })
    } else {
      const value = command.id === 'help' ? '/' : input.args
      commitEditorValue(value, value.length)
      closeAutocompleteMenu()
      command.onSelect?.()
    }
    return true
  }, [
    actionSlashCommands, appCandidates, appSlashCommands, closeAutocompleteMenu, commitEditorValue,
    canSend, disabled, filteredSlashCommands.length, isComposing, modelMenuOpen, models, onSelectModel,
    onSetGoal, onSubmit, selectedModel, skillCandidates, skillSlashCommands, slashScope, t, textOnly,
  ])

  useImperativeHandle(slashSubmitRef, () => submitSlashCommand, [submitSlashCommand])

  const selectSlashCommand = useCallback(
    (command: SlashCommand, explicitTrigger?: ComposerTextTrigger | null) => {
      if (command.enabled === false) return false
      if (command.skill) return selectSkill(command.skill, explicitTrigger)
      if (command.app) {
        const appCandidate = appCandidates.find(candidate => candidate.app.id === command.app?.id)
        return appCandidate ? selectMentionCandidate(appCandidate, explicitTrigger) : false
      }

      const trigger =
        explicitTrigger ??
        (activeMenuRef.current?.kind === 'slash' ? activeMenuRef.current.trigger : null)
      const editor = editorRef.current
      if (!trigger || !editor) return false

      const snapshot = editor.getSnapshot()
      if (command.requiresEmptyComposer && hasDraftTextForSlashCommands(snapshot.value)) return false
      if (command.id === 'help' || command.requiresArguments || command.insertOnSelect) {
        const nextValue = command.id === 'help' ? '/' : `${command.title} `
        commitEditorValue(nextValue, nextValue.length)
        closeAutocompleteMenu()
        editor.focus()
        return true
      }
      if (command.run || command.prompt || command.id === 'mention' || command.id === 'skill') {
        return submitSlashCommand(command.title)
      }
      const nextValue =
        snapshot.value.slice(0, trigger.start) + snapshot.value.slice(snapshot.selectionEnd)
      const nextCursor = trigger.start

      commitEditorValue(nextValue, nextCursor)
      closeAutocompleteMenu()
      command.onSelect?.()
      textareaRef.current?.focus()
      editor.focus()
      return true
    },
    [
      appCandidates,
      closeAutocompleteMenu,
      commitEditorValue,
      selectMentionCandidate,
      selectSkill,
      submitSlashCommand,
      textareaRef,
    ]
  )

  const selectMentionMenuRow = useCallback(
    (row: MentionMenuRow, explicitTrigger?: ComposerTextTrigger) => {
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor) return false
      if (!isMentionMenuRowEnabled(row, canPickNativeWorkspacePaths)) return false
      if (row.kind === 'candidate') {
        const selected = selectMentionCandidate(row.candidate, trigger)
        if (selected && row.candidate.kind === 'cloud' && row.candidate.project) {
          onSelectCloudProject?.(row.candidate.project)
        }
        return selected
      }
      if (row.kind === 'plugin-skills-action' || row.kind === 'plugin-back-action') {
        const snapshot = editor.getSnapshot()
        setPluginSkills(row.kind === 'plugin-skills-action' ? row.plugin : null)
        commitEditorValue(
          snapshot.value.slice(0, trigger.start + 1) + snapshot.value.slice(snapshot.selectionEnd),
          trigger.start + 1
        )
        setSelectedIndex(0)
        highlightedIndexRef.current = 0
        editor.focus()
        return true
      }
      if (row.kind === 'cloud-projects-action') {
        setCloudProjectsOpen(true)
        setSelectedIndex(0)
        highlightedIndexRef.current = 0
        return true
      }
      if (row.kind === 'cloud-back-action') {
        setCloudProjectsOpen(false)
        setSelectedIndex(0)
        highlightedIndexRef.current = 0
        return true
      }

      const snapshot = editor.getSnapshot()
      if (row.kind === 'cloud-space-direct-action') {
        const replacement = replaceComposerMentionTrigger(
          snapshot.value,
          cloudSpaceDirectReference,
          trigger.start,
          snapshot.selectionEnd
        )
        commitEditorValue(replacement.value, replacement.cursor)
        closeAutocompleteMenu()
        editor.focus()
        return true
      }
      if (row.kind === 'path') {
        const path = resolveComposerWorkspacePath(row.item.root, row.item.path)
        const reference = createComposerPathReference(path, row.item.matchType === 'directory')
        const replacement = replaceComposerMentionTrigger(
          snapshot.value,
          reference,
          trigger.start,
          snapshot.selectionEnd
        )
        commitEditorValue(replacement.value, replacement.cursor)
        closeAutocompleteMenu()
        editor.focus()
        return true
      }

      const nextValue =
        snapshot.value.slice(0, trigger.start) + snapshot.value.slice(snapshot.selectionEnd)
      commitEditorValue(nextValue, trigger.start)
      closeAutocompleteMenu()
      if (row.kind === 'goal-action') onSetGoal?.()
      if (row.kind === 'plan-action') onSetPlanMode?.()
      if (row.kind === 'files-action') {
        void openNativeWorkspacePathPicker(workspaceTarget?.path)
          .then(insertPathReferences)
          .catch(error => {
            console.warn('[KCoder Studio composer] native workspace picker failed', error)
          })
      }
      editor.focus()
      return true
    },
    [
      closeAutocompleteMenu,
      canPickNativeWorkspacePaths,
      cloudSpaceDirectReference,
      commitEditorValue,
      insertPathReferences,
      onSelectCloudProject,
      onSetGoal,
      onSetPlanMode,
      selectMentionCandidate,
      workspaceTarget?.path,
    ]
  )

  const selectHighlightedMention = useCallback(() => {
    const row = mentionMenuRows[highlightedIndexRef.current]
    return row ? selectMentionMenuRow(row) : false
  }, [mentionMenuRows, selectMentionMenuRow])

  const handleMentionRowClick = useCallback(
    (index: number) => {
      const row = mentionMenuRows[index]
      if (!row) return
      setSelectedIndex(index)
      selectMentionMenuRow(row, activeMenu?.trigger)
    },
    [activeMenu?.trigger, mentionMenuRows, selectMentionMenuRow]
  )

  const selectHighlightedSlashCommand = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return false
    const snapshot = editor.getSnapshot()
    const currentSlashTrigger = findStandaloneTrigger(
      snapshot.value,
      snapshot.selectionOffset,
      '/',
      'slash'
    )
    const commands = currentSlashTrigger
      ? filterSlashCommands(
          slashCommands,
          currentSlashTrigger.query,
          hasDraftTextForSlashCommands(snapshot.value)
        )
      : filteredSlashCommands
    const command = commands[highlightedIndexRef.current] ?? commands[0]
    if (!command || command.enabled === false) return false
    return selectSlashCommand(command, currentSlashTrigger)
  }, [filteredSlashCommands, selectSlashCommand, slashCommands])

  const getModelCompatibilityDisabledMessage = useCallback(
    (model: UnifiedModel): string | undefined => {
      if (!model.compatibilityDisabled) return undefined
      if (model.compatibilityDisabledReason === 'missing_current_runtime_family') {
        return t(
          'workbench.model_disabled_missing_current_runtime_family',
          'Current model is missing runtime.family'
        )
      }
      if (model.compatibilityDisabledReason === 'missing_target_runtime_family') {
        return t(
          'workbench.model_disabled_missing_target_runtime_family',
          'This model is missing runtime.family'
        )
      }
      if (model.compatibilityDisabledReason === 'unavailable') {
        return t('workbench.model_disabled_unavailable', 'This model is unavailable')
      }
      return t(
        'workbench.model_disabled_runtime_family_mismatch',
        'Incompatible with the current model protocol'
      )
    },
    [t]
  )

  const selectSlashModel = useCallback(
    (model: UnifiedModel) => {
      onSelectModel?.(model)
      closeSlashModelMenu(true)
    },
    [closeSlashModelMenu, onSelectModel]
  )


  useEffect(() => {
    const handleFocusRequest = (event: Event) => {
      if (textOnly) return
      const detail = (event as CustomEvent<{ expectedValue?: string }>).detail
      if (detail?.expectedValue && detail.expectedValue !== valueRef.current) return
      const editor = editorRef.current
      if (!editor) return
      editor.setValue(valueRef.current, valueRef.current.length)
      editor.focus()
      closeAutocompleteMenu()
    }

    window.addEventListener(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, handleFocusRequest)
    return () => {
      window.removeEventListener(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, handleFocusRequest)
    }
  }, [closeAutocompleteMenu, textOnly])

  useEffect(() => {
    let focusFrame: number | null = null
    const handleNewChatFocusRequest = () => {
      if (textOnly) return
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = null
        const editor = editorRef.current
        if (!editor) return
        editor.setValue(valueRef.current, valueRef.current.length)
        editor.focus()
        closeAutocompleteMenu()
      })
    }

    window.addEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, handleNewChatFocusRequest)
    return () => {
      window.removeEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, handleNewChatFocusRequest)
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
    }
  }, [closeAutocompleteMenu, textOnly])

  useEffect(() => {
    if (!showSkillMenu && !showSlashMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) || textareaRef.current?.contains(target))
      ) {
        return
      }
      closeAutocompleteMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeAutocompleteMenu, showSkillMenu, showSlashMenu, textareaRef])

  useEffect(() => {
    if (!modelMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        (modelMenuRef.current?.contains(target) || textareaRef.current?.contains(target))
      ) {
        return
      }
      closeSlashModelMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeSlashModelMenu, modelMenuOpen, textareaRef])

  const handleCompositionStart = useCallback(() => {
    setIsComposing(true)
    debugComposerEvent('composition-start', {
      propValue: textMetrics(valueRef.current),
      suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
    })
  }, [])

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false)
    suppressEnterUntilKeyUpRef.current = true
    debugComposerEvent('composition-end', {
      propValue: textMetrics(valueRef.current),
      suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
    })
  }, [])

  const handleKeyUp = (event: KeyboardEvent) => {
    if (suppressEnterUntilKeyUpRef.current) {
      suppressEnterUntilKeyUpRef.current = false
      debugComposerEvent('keyup-clear-composition-enter-suppression', {
        key: event.key,
        propValue: textMetrics(valueRef.current),
      })
    }
    if (event.key === 'Escape' && suppressEscapeAutocompleteKeyUpRef.current) {
      suppressEscapeAutocompleteKeyUpRef.current = false
      return
    }
    updateAutocompleteTrigger()
  }

  const handleEditorSnapshot = useCallback(
    (snapshot: ComposerEditorSnapshot) => {
      inputHistoryRef.current.navigation.observe(snapshot.value)
      valueRef.current = snapshot.value
      setSlashCommandError(null)
      setSlashNotice(null)
      updateAutocompleteTrigger(snapshot)
    },
    [updateAutocompleteTrigger]
  )

  const handleEditorBeforeInput = useCallback((event: InputEvent) => {
    if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') {
      return false
    }
    return suppressEnterUntilKeyUpRef.current
  }, [])

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent, snapshot: ComposerEditorSnapshot) => {
      if (disabled) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (
          disabled ||
          modelMenuOpen ||
          event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          isComposing ||
          isImeComposingEvent(event)
        )
          return false
        if (showSkillMenuRef.current || showSlashMenuRef.current) {
          if (activeOptionCountRef.current <= 0) return false
          event.preventDefault()
          return moveHighlightedIndex(event.key === 'ArrowDown' ? 1 : -1)
        }
        if (snapshot.selectionStart !== snapshot.selectionEnd) return false
        if (inputHistoryRef.current.scope !== inputHistoryScope) {
          inputHistoryRef.current = {
            scope: inputHistoryScope,
            navigation: new ComposerInputHistory(),
          }
        }
        const history = inputHistoryRef.current.navigation
        const direction = event.key === 'ArrowUp' ? 'up' : 'down'
        if (!history.isBrowsing(snapshot.value) && (direction === 'down' || !inputHistory.length))
          return false
        const next = history.move(
          direction,
          inputHistory,
          snapshot,
          history.isBrowsing(snapshot.value) ||
            Boolean(editorRef.current?.isAtVerticalBoundary(direction))
        )
        if (!next) return false
        event.preventDefault()
        commitEditorValue(next.value, next.selectionOffset)
        closeAutocompleteMenu()
        return true
      }

      if (event.key === 'Escape') {
        if (!showSkillMenuRef.current && !showSlashMenuRef.current) return false
        event.preventDefault()
        suppressEscapeAutocompleteKeyUpRef.current = true
        closeAutocompleteMenu()
        return true
      }

      if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !disabled &&
        !modelMenuOpen &&
        !isComposing &&
        !isImeComposingEvent(event)
      ) {
        if (showSkillMenuRef.current && activeOptionCountRef.current > 0) {
          selectHighlightedMention()
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        if (showSlashMenuRef.current && selectHighlightedSlashCommand()) {
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        if (!submitSlashCommand(snapshot.value)) return false
        event.preventDefault()
        event.stopPropagation()
        return true
      }

      if (event.key === 'Enter') {
        debugComposerEvent('keydown-enter', {
          shiftKey: event.shiftKey,
          canSend,
          stateIsComposing: isComposing,
          nativeIsComposing: event.isComposing,
          suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
          showSkillMenu: showSkillMenuRef.current,
          showSlashMenu: showSlashMenuRef.current,
          highlightedIndex: highlightedIndexRef.current,
          activeOptionCount: activeOptionCountRef.current,
          domValue: textMetrics(snapshot.value),
        })

        if (isComposing || isImeEnterEvent(event) || isImeComposingEvent(event)) {
          suppressEnterUntilKeyUpRef.current = true
          return false
        }
        if (suppressEnterUntilKeyUpRef.current) {
          event.preventDefault()
          return true
        }
        if (event.shiftKey && !event.metaKey && !event.ctrlKey) return false
        if (showSkillMenuRef.current && activeOptionCountRef.current > 0) {
          selectHighlightedMention()
          suppressEnterUntilKeyUpRef.current = true
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        if (submitSlashCommand(snapshot.value)) {
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        event.preventDefault()
        if (snapshot.value.trim().length > 0 || canSend) {
          const modifierPressed = event.metaKey || event.ctrlKey
          onSubmit(
            snapshot.value,
            modifierPressed
              ? event.shiftKey
                ? { interruptWhenBusy: true }
                : { guideWhenBusy: true }
              : undefined
          )
        }
        return true
      }

      if (event.key !== 'Backspace' && event.key !== 'Delete') return false
      const range = findComposerMentionDeletionRange(
        snapshot.value,
        snapshot.selectionStart,
        snapshot.selectionEnd,
        event.key
      )
      if (!range) return false
      event.preventDefault()
      const nextValue = snapshot.value.slice(0, range.start) + snapshot.value.slice(range.end)
      editorRef.current?.setValue(nextValue, range.cursor)
      return true
    },
    [
      canSend,
      closeAutocompleteMenu,
      commitEditorValue,
      isComposing,
      inputHistory,
      inputHistoryScope,
      disabled,
      modelMenuOpen,
      moveHighlightedIndex,
      onSubmit,
      selectHighlightedMention,
      selectHighlightedSlashCommand,
      submitSlashCommand,
    ]
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      if (textOnly) return false
      if (!event.clipboardData) return false
      const clipboardData = event.clipboardData
      const files = Array.from(clipboardData.files)
      if (files.length > 0) {
        event.preventDefault()
        void resolveDataTransferWorkspacePaths(
          clipboardData,
          'clipboard',
          workspaceTarget?.workspaceSource
        ).then(({ attachmentFiles, referenceEntries }) => {
          insertPathReferences(referenceEntries)
          if (attachmentFiles.length > 0) onPasteFiles?.(attachmentFiles)
        })
        return true
      }
      if (!onPasteFiles) return false
      const textAttachment = createLongPastedTextAttachment(clipboardData.getData('text/plain'))
      if (!textAttachment) return false
      event.preventDefault()
      onPasteFiles([textAttachment])
      return true
    },
    [insertPathReferences, onPasteFiles, workspaceTarget?.workspaceSource, textOnly]
  )

  const handleDrop = useCallback(
    (event: DragEvent) => {
      if (textOnly) return false
      const dataTransfer = event.dataTransfer
      if (!dataTransfer || !Array.from(dataTransfer.types).includes('Files')) return false
      event.preventDefault()
      event.stopPropagation()
      void resolveDataTransferWorkspacePaths(
        dataTransfer,
        'drop',
        workspaceTarget?.workspaceSource
      ).then(({ attachmentFiles, referenceEntries }) => {
        insertPathReferences(referenceEntries)
        if (attachmentFiles.length > 0) onPasteFiles?.(attachmentFiles)
      })
      return true
    },
    [insertPathReferences, onPasteFiles, workspaceTarget?.workspaceSource, textOnly]
  )

  return (
    <div className="relative min-w-0 flex-1 w-full">
      {slashNotice?.scope === slashScope && !slashCommandError && (
        <div
          role="status"
          data-testid="composer-slash-command-status"
          data-fading={slashNoticeFading || undefined}
          {...slashOverlayHoldProps}
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-popover max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary shadow-lg transition-opacity duration-300 data-[fading]:opacity-0 motion-reduce:transition-none"
        >
          {slashNotice.message}
        </div>
      )}
      {slashCommandError && (
        <div
          role="alert"
          data-testid="composer-slash-command-error"
          data-fading={slashErrorFading || undefined}
          {...slashOverlayHoldProps}
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-popover max-w-full break-words rounded-lg border border-red-500/30 bg-background px-3 py-2 text-sm text-red-500 shadow-lg transition-opacity duration-300 data-[fading]:opacity-0 motion-reduce:transition-none"
        >
          {slashCommandError}
        </div>
      )}
      <ComposerProseMirrorEditor
        key="composer-editor-multiline-paste-v3"
        ref={editorRef}
        value={value}
        onChange={nextValue => {
          valueRef.current = nextValue
          onChange(nextValue)
        }}
        onSnapshotChange={handleEditorSnapshot}
        onKeyDown={handleEditorKeyDown}
        onBeforeInput={handleEditorBeforeInput}
        onKeyUp={handleKeyUp}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onOpenMentionFile={onOpenSkillFile}
        onClick={() => updateAutocompleteTrigger()}
        onFocus={() => updateAutocompleteTrigger()}
        disabled={disabled}
        placeholder={placeholder}
        testId={testId}
        rows={rows}
        textareaRef={textareaRef}
        className={className}
      />
      {showSkillMenu && (
        <ComposerMentionMenu
          menuRef={menuRef}
          rows={mentionMenuRows}
          selectedIndex={highlightedIndex}
          className={skillMenuClassName}
          mentionMode={activeMenu?.kind === 'mention'}
          projectSpaceScope={cloudProjectsOpen || cloudProjectScopeActive}
          loading={isMentionLoading || workspaceSearch.loading}
          error={hasMentionLoadError || workspaceSearch.error || pluginSource.error}
          canBrowseFiles={canPickNativeWorkspacePaths}
          onRetry={() => { retryLocalMentions(); pluginSource.retry() }}
          onHighlight={setSelectedIndex}
          onSelect={handleMentionRowClick}
        />
      )}
      {showSlashMenu && (
        <div ref={menuRef}>
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={highlightedIndex}
            className={skillMenuClassName}
            title={t('workbench.slash_command_menu_title')}
            noResultsLabel={t('workbench.no_slash_commands')}
            loadingSkills={isSlashMentionLoading}
            skillLoadError={hasSlashMentionLoadError}
            skillGroupLabel={t('workbench.slash_command_group_skills')}
            skillLoadingLabel={t('workbench.loading_slash_command_skills')}
            skillLoadErrorLabel={t('workbench.slash_command_skills_error')}
            skillRetryLabel={t('workbench.retry_local_skills')}
            onSelectCommand={command => selectSlashCommand(command)}
            onHighlightCommand={setSelectedIndex}
            onRetrySkills={() => retryLocalMentions()}
          />
        </div>
      )}
      {modelMenuOpen && (
        <div ref={modelMenuRef}>
          <SlashModelMenu
            models={models}
            selectedModel={selectedModel ?? null}
            selectedModelOptions={selectedModelOptions}
            query={modelQuery}
            selectedIndex={modelSelectedIndex}
            className={skillMenuClassName}
            searchPlaceholder={t('workbench.search_models')}
            noResultsLabel={t('workbench.no_models')}
            onQueryChange={setModelQuery}
            onSelectedIndexChange={setModelSelectedIndex}
            onSelectModel={selectSlashModel}
            onBlockedModelSelect={onBlockedModelSelect}
            onClose={() => closeSlashModelMenu(true)}
            getCompatibilityDisabledMessage={getModelCompatibilityDisabledMessage}
          />
        </div>
      )}
    </div>
  )
}
