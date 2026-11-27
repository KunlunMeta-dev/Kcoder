import { Clipboard, FileText, List, Pencil, Plus, Settings, Terminal } from 'lucide-react'
import { SlashCommandInputError, type SlashCommand } from '@/components/chat/composer/composerAutocomplete'
import { kcoderSlashCatalog, kworkerSlashNames } from '@/components/chat/composer/slashCatalog'
import { settingsPath, availableSettings, type SettingsKey } from '@/components/settings/settingsNavigation'
import { taskAgentBinding } from '@/features/experts/taskAgentBinding'
import { studioWorkMode, useStudioWorkMode } from '@/features/workbench/studioWorkMode'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { findRuntimeTaskWorkspace } from '@/features/workbench/workbenchRuntimeHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { navigateTo } from '@/lib/navigation'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import type { RuntimeContextUsage, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import type { WorkbenchPaneSession } from '../useWorkbenchPaneSession'
import { useNativeSlashTerminal } from './useNativeSlashTerminal'
import { registerDesktopSlashCommands, type PaneSlashIntegrations } from './paneSlashDesktopCommands'
import { opensKcoderTerminal } from './studioSlashPolicy'
import { initAgentsPrompt, ocrReviewPrompt } from './studioSlashPrompts'

interface PaneSlashOptions {
  session?: WorkbenchPaneSession
  target?: WorkspaceTarget | null
  isGateway?: boolean
  layout?: 'desktop' | 'mobile'
  openDiff?: () => void
  contextUsage?: RuntimeContextUsage
  integrations?: PaneSlashIntegrations
}

type Action = Omit<SlashCommand, 'id' | 'title' | 'testId' | 'description'>

export function usePaneSlashActions(
  address: RuntimeTaskAddress | null,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | undefined,
  enabled: boolean,
  options: PaneSlashOptions = {}
) {
  const { t } = useTranslation('common')
  const { openStandaloneWorkspace, renameRuntimeTask, selectProjectWorkspace, openRuntimeTask, searchRuntimeWork, startNewChat } = useWorkbench()
  const mode = useStudioWorkMode(address)
  const workspace = findRuntimeTaskWorkspace(runtimeWork, address)
  const deviceId = address?.deviceId ?? options.target?.deviceId
  const workspacePath = address
    ? address.workspacePath || workspace?.workspacePath || undefined
    : options.target?.path
  const threadId = address && runtimeThreadId(address)
  const terminal = useNativeSlashTerminal(deviceId, workspacePath, JSON.stringify([address?.taskId, threadId, mode, enabled]))
  const commands: SlashCommand[] = []
  const session = options.session
  const protectedSession = taskAgentBinding(address)?.source === 'channel' || address?.runtimeHandle?.channelTaskSource
  if (!enabled || protectedSession) return { commands, nativeTerminal: null }

  const add = (id: string, action: Action) => {
    const name = `/${id}`
    if (mode === 'kworker' && !kworkerSlashNames.has(name)) return
    const metadata = kcoderSlashCatalog.find(command => command.name === name)
    commands.push({
      id,
      title: name,
      testId: id,
      description: t(`workbench.slash_commands.${id}`),
      aliases: metadata?.aliases,
      usage: metadata?.usage,
      requiresEmptyComposer: true,
      ...action,
    })
  }
  const badArguments = () => new SlashCommandInputError(t('workbench.slash_invalid_arguments'))
  const openSettings = (key?: SettingsKey, search = '') => {
    const page = key && availableSettings(options.layout ?? 'desktop', Boolean(options.isGateway), false)
      .find(item => item.key === key)
    if (key && !page) return
    return () => navigateTo(`${page ? settingsPath(page) : '/settings'}${search}`)
  }
  const settings = (id: string, key?: SettingsKey) => {
    const open = openSettings(key)
    if (open) add(id, { Icon: Settings, run: open })
  }

  if (address) {
    add('rename', {
      Icon: Pencil,
      acceptsArguments: true,
      requiresArguments: true,
      run: title => renameRuntimeTask(address, title, { throwOnRejection: true }),
    })
  }
  if (workspace?.available) {
    const ownerProjectId = workspace.projectId === undefined ? projectId : workspace.projectId
    const workspaceId = workspace.id
    const start = ownerProjectId != null
      ? workspaceId != null ? () => selectProjectWorkspace(ownerProjectId, workspaceId) : undefined
      : () => openStandaloneWorkspace(workspace.deviceId, workspace.workspacePath, workspace.label ?? undefined)
    if (start) add('new', { Icon: Plus, aliases: ['/clear'], run: start })
  } else if (!address && startNewChat) {
    add('new', { Icon: Plus, aliases: ['/clear'], run: startNewChat })
  }

  if (session) {
    settings('settings')
    settings('theme', 'appearance')
    settings('tools', 'tools')
    settings('keys', 'keyboard-shortcuts')
    settings('hooks', 'hooks')
    add('plugins', { Icon: Settings, run: () => navigateTo('/plugins') })
    add('wiki', { Icon: FileText, run: () => navigateTo('/knowledge') })
    add('workflow', {
      Icon: List, acceptsArguments: true, matchesArguments: args => !args || args === 'list',
      run: () => navigateTo('/workflows'),
    })
    add('memories', { Icon: FileText, run: () => navigateTo('/memory') })
    if (options.openDiff) add('diff', { Icon: FileText, run: options.openDiff })
  }

  if (address && session) {
    add('status', {
      Icon: List,
      run: () => t('workbench.slash_session_status', {
        state: t(session.status.isBusy ? 'workbench.slash_session_running' : 'workbench.slash_session_idle'),
        thread: threadId || address.taskId,
      }),
    })
    add('copy', {
      Icon: Clipboard, acceptsArguments: true, matchesArguments: args => !args || args === 'view',
      run: async (args, current) => {
        const answer = [...session.messages].reverse().find(message =>
          message.role === 'assistant' && message.status === 'done' && message.content.trim())
        if (!answer) return t('workbench.slash_no_answer')
        if (args === 'view') return answer.content
        if (current?.() === false) return
        await copyTextToClipboard(answer.content)
        return t('workbench.slash_answer_copied')
      },
    })
    add('history', {
      Icon: List, acceptsArguments: true,
      run: async args => {
        const count = args ? Number(args) : 10
        if (!Number.isInteger(count) || count < 1 || count > 100) throw badArguments()
        const visibleMessages = session.messages.filter(message => message.role === 'user' || message.role === 'assistant')
        const messages = visibleMessages.length >= count || !session.transcriptHasMoreBefore
          ? visibleMessages : await session.loadFullTranscriptForExport()
        return messages.filter(message => message.role === 'user' || message.role === 'assistant')
          .slice(-count)
          .map(message => `${t(`workbench.slash_history_${message.role}`)} · ${message.content.trim().slice(0, 500)}`)
          .join('\n') || t('workbench.slash_no_history')
      },
    })
    add('queue', {
      Icon: List, acceptsArguments: true, matchesArguments: args => !args || args === 'clear',
      run: args => {
        if (args === 'clear') {
          session.clearQueuedMessages()
          return t('workbench.slash_queue_cleared')
        }
        return t('workbench.slash_queue_count', { count: session.queuedMessages.length })
      },
    })
    const listAgents = (runningOnly: boolean) => session.subagentStatuses
      .filter(agent => !runningOnly || agent.status === 'running')
      .map(agent => `${agent.agentName} · ${agent.agentId} · ${agent.status}`)
      .join('\n') || t('workbench.slash_no_agents')
    add('tasks', { Icon: List, run: () => listAgents(false) })
    add('ps', { Icon: List, run: () => listAgents(true) })
    add('todos', {
      Icon: List,
      run: () => session.taskPlan?.plan.map(step => `${step.status} · ${step.step}`).join('\n') ||
        t('workbench.slash_no_plan_steps'),
    })
    if (options.contextUsage) {
      const total = options.contextUsage.total
      add('usage', {
        Icon: List,
        run: () => t('workbench.slash_session_usage', {
          input: total.inputTokens.toLocaleString(),
          output: total.outputTokens.toLocaleString(),
          cached: total.cachedInputTokens.toLocaleString(),
          reasoning: total.reasoningOutputTokens.toLocaleString(),
        }),
      })
    }
  }

  if (session && deviceId && runtimeWork) {
    const workspaces = [...runtimeWork.projects.flatMap(project => project.deviceWorkspaces), ...runtimeWork.chats]
    const sessions = workspaces.filter(item => item.deviceId === deviceId)
      .flatMap(item => item.tasks)
      .filter(task => !task.optimistic && task.continuable !== false && studioWorkMode(task.runtimeHandle?.studioWorkMode) === mode)
    const latest = new Map(sessions.map(task => [task.taskId, task]))
    const listed = [...latest.values()].sort((left, right) =>
      new Date(right.updatedAt ?? right.createdAt ?? 0).getTime() -
      new Date(left.updatedAt ?? left.createdAt ?? 0).getTime()
    )
    const list = (count: number) => listed.slice(0, count)
      .map(task => `${task.threadId || task.taskId} · ${task.title}`).join('\n') ||
      t('workbench.slash_no_sessions')
    add('sessions', {
      Icon: List, acceptsArguments: true, matchesArguments: args => !args || /^\d+$/.test(args),
      run: args => {
        const count = args ? Number(args) : 10
        if (!Number.isInteger(count) || count < 1 || count > 100) throw badArguments()
        return list(count)
      },
    })
    add('resume', {
      Icon: List, acceptsArguments: true, matchesArguments: args => !args.startsWith('-'),
      run: async (query, current) => {
        if (!query) return list(10)
        const matched = listed.filter(task => task.taskId === query || task.threadId === query)
        if (matched.length === 1) {
          const task = matched[0]
          await openRuntimeTask({
            deviceId, taskId: task.taskId, threadId: task.threadId, workspacePath: task.workspacePath,
            runtimeHandle: task.runtimeHandle,
          })
          return
        }
        const { items } = await searchRuntimeWork({ query, limit: 50 })
        if (current?.() === false) return
        const exactMatches = items.filter(item => item.address.deviceId === deviceId &&
          studioWorkMode(item.address.runtimeHandle?.studioWorkMode) === mode &&
          (item.address.taskId === query || item.address.threadId === query))
        const exact = new Map(exactMatches.map(item => [item.address.taskId, item.address]))
        if (exact.size !== 1) throw new SlashCommandInputError(t('workbench.slash_resume_exact'))
        const [resolved] = exact.values()
        await openRuntimeTask(resolved)
      },
    })
  }

  registerDesktopSlashCommands({
    add, t, address, session, isGateway: Boolean(options.isGateway),
    integrations: options.integrations ?? {}, openSettings,
  })

  if (mode === 'kcoder' && session && deviceId && workspacePath) {
    add('init', { Icon: FileText, prompt: initAgentsPrompt })
    add('ocr', { Icon: FileText, acceptsArguments: true, prompt: ocrReviewPrompt })
    add('learn', {
      Icon: FileText, acceptsArguments: true,
      prompt: request => [
        'Distill the sources and requirements below into one reusable KCoder skill. Use the current conversation when no source is specified.',
        'Find and follow existing skill-writing guidance. Inspect relevant skills and improve one when it covers the same procedure.',
        'Use the allowed skill management tools to create or edit the skill and verify it can be retrieved. If skill writes are unavailable, produce the proposed SKILL.md and report that it was not saved.',
        request,
      ].filter(Boolean).join('\n\n'),
    })
    add('review', {
      Icon: FileText, acceptsArguments: true,
      prompt: instructions => [
        'Review the current workspace changes, including untracked files. Identify correctness problems, regressions, security risks and test gaps.',
        'Read the changes without editing files. Report findings by severity with file and line references, or state that there are no findings.',
        instructions,
      ].filter(Boolean).join('\n\n'),
    })
  }

  // The KCoder terminal is a fallback for commands without a desktop equivalent.
  // Studio handlers above come first, so they win for the arguments they accept;
  // the composer lists only the first entry per name. Mobile layouts cannot host
  // the terminal dialog usefully and offer the Studio handlers only.
  if (mode === 'kcoder' && options.isGateway && options.layout !== 'mobile') {
    for (const command of kcoderSlashCatalog) {
      if (!opensKcoderTerminal(command.name)) continue
      const needsThread = Boolean(address && !command.workspaceOnly)
      commands.push({
        id: command.name.slice(1),
        title: command.name,
        testId: command.name.slice(1),
        aliases: command.aliases,
        usage: command.usage,
        description: t(`workbench.slash_commands.${command.name.slice(1)}`),
        Icon: Terminal,
        group: t('workbench.slash_native_group'),
        metaLabel: t('workbench.slash_native_meta'),
        requiresEmptyComposer: true,
        requiresArguments: command.requiresArguments,
        acceptsArguments: true,
        insertOnSelect: true,
        enabled: Boolean(deviceId && workspacePath && (!needsThread || threadId)),
        run: args => terminal.run([command.name, args].filter(Boolean).join(' '), needsThread ? threadId ?? undefined : undefined),
      })
    }
  }
  return { commands, nativeTerminal: terminal.launch ? {
    launch: terminal.launch, onClose: terminal.close, onExit: terminal.markExited,
  } : null }
}
