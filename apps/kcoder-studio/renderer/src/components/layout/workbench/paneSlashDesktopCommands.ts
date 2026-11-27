import type { RefObject } from 'react'
import type { TFunction } from 'i18next'
import {
  ArrowDownUp,
  Bot,
  Brain,
  ListTree,
  MessageCircle,
  Plug,
  Settings,
  ShieldCheck,
  Square,
  Stethoscope,
  ThumbsUp,
} from 'lucide-react'
import { SlashCommandInputError, type SlashCommand } from '@/components/chat/composer/composerAutocomplete'
import type { TranscriptNavigationControl } from '@/components/chat/ScrollableMessageArea'
import { offerMemoryDraft } from '@/features/knowledge-integration/memoryDraftHandoff'
import { listEvolutionRatings, rateEvolutionTurn } from '@/kcoder/evolution/evolutionApi'
import { publishEvolutionTurnRated } from '@/kcoder/evolution/evolutionEvents'
import { runtimeNameForCurrentHost } from '@/kcoder/legacyRuntimeAbi'
import { navigateTo } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import type { WorkbenchPaneSession } from '../useWorkbenchPaneSession'

type Action = Omit<SlashCommand, 'id' | 'title' | 'testId' | 'description'>
type AddSlashCommand = (id: string, action: Action) => void

/** Desktop features a pane can lend to slash commands. Absent features hide their commands. */
export interface PaneSlashIntegrations {
  /** Opens a Studio temporary chat for the current task; `submit` sends the input at once. */
  openTemporaryChat?: (initialInput?: string, options?: { submit?: boolean }) => void
  /** The composer permission selector for the session's next turns. */
  permission?: { value?: string; set: (mode: string) => void; disabled?: boolean }
  /** Subagent workspace navigation; `close` is present while a subagent view is open. */
  subagents?: {
    statuses: readonly RuntimeSubagentStatus[]
    open?: (agentId: string) => void
    close?: () => void
  }
  transcript?: RefObject<TranscriptNavigationControl | null>
  /** Opens the task diagnostics (feedback) dialog. */
  openDiagnostics?: () => void
}

interface DesktopSlashContext {
  add: AddSlashCommand
  t: TFunction
  address: RuntimeTaskAddress | null
  session?: WorkbenchPaneSession
  isGateway: boolean
  integrations: PaneSlashIntegrations
  openSettings: (key: 'self-evolution' | 'general', search?: string) => (() => void) | undefined
}

const PERMISSION_MODES = ['ask', 'auto', 'accept_edits', 'dont_ask', 'bypass', 'yolo', 'default']
const JUMP_ACTIONS = ['start', 'prev', 'next', 'latest'] as const
const OUTLINE_LIMIT = 50

function noArgumentsOr(...accepted: string[]) {
  return (args: string) => !args || accepted.includes(args.trim().toLowerCase())
}

/** Exact agent id first, then a unique case-insensitive agent name. */
export function resolveSubagent(statuses: readonly RuntimeSubagentStatus[], query: string) {
  const exact = statuses.filter(agent => agent.agentId === query || agent.id === query)
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null
  const named = statuses.filter(agent => agent.agentName.toLowerCase() === query.toLowerCase())
  return named.length === 1 ? named[0] : null
}

export function registerDesktopSlashCommands({
  add,
  t,
  address,
  session,
  isGateway,
  integrations,
  openSettings,
}: DesktopSlashContext) {
  const fail = (message: string) => new SlashCommandInputError(message)
  const usage = (key: string) => fail(t(key))

  if (integrations.openTemporaryChat) {
    const openTemporaryChat = integrations.openTemporaryChat
    add('btw', {
      Icon: MessageCircle,
      usage: '/btw [question]',
      acceptsArguments: true,
      insertOnSelect: true,
      run: question => openTemporaryChat(question || undefined, { submit: Boolean(question) }),
    })
  }

  const permission = integrations.permission
  if (permission && runtimeNameForCurrentHost() === 'kcoder') {
    const label = (mode: string) => t(`workbench.permission_mode_${mode}`)
    add('permission', {
      Icon: ShieldCheck,
      acceptsArguments: true,
      run: args => {
        if (!args) {
          return t('workbench.slash_permission_current', { mode: label(permission.value ?? 'default') })
        }
        const mode = args.trim().toLowerCase().replace(/-/g, '_')
        if (!PERMISSION_MODES.includes(mode)) throw usage('workbench.slash_permission_invalid')
        if (permission.disabled) throw usage('workbench.slash_permission_busy')
        permission.set(mode)
        return t('workbench.slash_permission_set', { mode: label(mode) })
      },
    })
  }

  if (session) {
    add('remember', {
      Icon: Brain,
      acceptsArguments: true,
      requiresArguments: true,
      run: fact => {
        offerMemoryDraft(fact)
        navigateTo('/memory')
      },
    })
    add('mcp', {
      Icon: Plug,
      acceptsArguments: true,
      matchesArguments: noArgumentsOr('verbose'),
      run: () => navigateTo('/plugins/manage?view=mcp'),
    })
    add('skill-usage', {
      Icon: Settings,
      acceptsArguments: true,
      matchesArguments: noArgumentsOr('list'),
      run: () => navigateTo('/plugins/manage?view=skills'),
    })
    add('skills-hub', {
      Icon: Settings,
      acceptsArguments: true,
      matchesArguments: noArgumentsOr('list'),
      run: () => navigateTo('/plugins'),
    })
    const evolution = openSettings('self-evolution')
    if (evolution) {
      add('evolution', {
        Icon: Settings,
        acceptsArguments: true,
        matchesArguments: args => noArgumentsOr('status')(args) || /^list(\s|$)/i.test(args),
        run: evolution,
      })
    }
    const migration = isGateway ? openSettings('general', '?migration=open') : undefined
    if (migration) {
      add('migration', { Icon: Settings, run: migration })
      add('migrate', { Icon: Settings, run: migration })
    }
  }

  if (session && integrations.openDiagnostics) {
    add('debug', { Icon: Stethoscope, run: integrations.openDiagnostics })
  }

  const transcript = integrations.transcript
  if (session && transcript) {
    add('outline', {
      Icon: ListTree,
      acceptsArguments: true,
      run: args => {
        const control = transcript.current
        const turns = control?.turns() ?? []
        if (turns.length === 0) return t('workbench.slash_outline_empty')
        const lines = (items: typeof turns) => items.slice(-OUTLINE_LIMIT)
          .map(turn => `${turn.turnIndex + 1} · ${turn.promptPreview}`).join('\n')
        const query = args.trim()
        if (!query) return lines(turns)
        const matches = /^\d+$/.test(query)
          ? turns.filter(turn => turn.turnIndex + 1 === Number(query))
          : turns.filter(turn => `${turn.promptPreview}\n${turn.responsePreview}`
            .toLowerCase().includes(query.toLowerCase()))
        if (matches.length === 0) throw fail(t('workbench.slash_outline_no_match', { query }))
        if (!control?.goToTurn(matches[matches.length - 1].id)) {
          throw usage('workbench.slash_jump_unavailable')
        }
        return matches.length > 1 ? lines(matches) : undefined
      },
    })
    add('jump', {
      Icon: ArrowDownUp,
      acceptsArguments: true,
      requiresArguments: true,
      run: args => {
        const action = JUMP_ACTIONS.find(item => item === args.trim().toLowerCase())
        if (!action) throw usage('workbench.slash_jump_usage')
        if (!transcript.current?.jump(action)) return t('workbench.slash_jump_unavailable')
      },
    })
  }

  if (!address || !session) return

  const statuses = () => integrations.subagents?.statuses ?? session.subagentStatuses
  const findAgent = (query: string) => {
    const agent = resolveSubagent(statuses(), query)
    if (!agent) throw fail(t('workbench.slash_agent_not_found', { agent: query }))
    return agent
  }
  const openAgent = (agent: RuntimeSubagentStatus) => {
    const open = integrations.subagents?.open
    if (!open) throw usage('workbench.slash_agent_view_unavailable')
    open(agent.agentId)
  }

  add('agent', {
    Icon: Bot,
    acceptsArguments: true,
    run: async args => {
      const [, action = 'list', target = '', message = ''] =
        /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(args.trim()) ?? []
      switch (action.toLowerCase()) {
        case 'list':
          if (target) throw usage('workbench.slash_agent_usage')
          return statuses().map(agent => `${agent.agentName} · ${agent.agentId} · ${agent.status}`)
            .join('\n') || t('workbench.slash_no_agents')
        case 'view':
          if (!target || message) throw usage('workbench.slash_agent_usage')
          openAgent(findAgent(target))
          return
        case 'back': {
          if (target) throw usage('workbench.slash_agent_usage')
          const close = integrations.subagents?.close
          if (!close) return t('workbench.slash_agent_no_view')
          close()
          return
        }
        case 'steer': {
          if (!target || !message.trim()) throw usage('workbench.slash_agent_usage')
          const agent = findAgent(target)
          if (!(await session.steerSubagent(agent.agentId, message.trim()))) {
            throw usage('workbench.subagent_steer_rejected')
          }
          return t('workbench.slash_agent_steer_queued', { agent: agent.agentName })
        }
        default:
          throw usage('workbench.slash_agent_usage')
      }
    },
  })

  add('stop', {
    Icon: Square,
    acceptsArguments: true,
    run: async args => {
      const id = args.trim()
      if (!id) {
        if (!session.status.isBusy) return t('workbench.slash_stop_idle')
        await session.pauseCurrentResponse()
        return t('workbench.slash_stop_requested')
      }
      if (/\s/.test(id)) throw usage('workbench.slash_stop_usage')
      // Background runs are stopped from their own view, which checks the
      // run identity before the request; never stop by a guessed id here.
      const agent = findAgent(id)
      openAgent(agent)
      return t('workbench.slash_stop_agent_opened', { agent: agent.agentName })
    },
  })

  if (isGateway) {
    add('rate', {
      Icon: ThumbsUp,
      acceptsArguments: true,
      requiresArguments: true,
      run: async args => {
        const [, rating, reason] = /^(up|down)(?:\s+([\s\S]+))?$/i.exec(args.trim()) ?? []
        if (!rating) throw usage('workbench.slash_rate_usage')
        // Rate the newest turn the server recorded a usage for, addressed by the
        // server's own turn id and skill calls so compaction cannot misalign it.
        const listed = await listEvolutionRatings({ deviceId: address.deviceId, taskId: address.taskId })
          .catch(() => null)
        if (!listed) throw usage('workbench.slash_rate_failed')
        const latest = listed.items[0]
        if (!latest) return t('workbench.slash_rate_no_turn')
        const value = rating.toLowerCase() === 'up' ? 'up' : 'down'
        const turnId = latest.turnId
        const recorded = await rateEvolutionTurn({
          deviceId: address.deviceId,
          taskId: address.taskId,
          turnId,
          ...(latest.toolCallIds?.length ? { toolCallIds: latest.toolCallIds } : {}),
          rating: value,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        }).then(result => result.recorded, () => false)
        if (!recorded) throw usage('workbench.slash_rate_failed')
        publishEvolutionTurnRated({
          deviceId: address.deviceId, taskId: address.taskId, turnId, rating: value,
        })
        return t(value === 'up' ? 'workbench.slash_rate_recorded_up' : 'workbench.slash_rate_recorded_down')
      },
    })
  }
}
