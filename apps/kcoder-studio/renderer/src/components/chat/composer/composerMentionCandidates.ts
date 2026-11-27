import { useTranslation } from '@/hooks/useTranslation'
import { localSkillReference } from '@/lib/local-skill-reference'
import { getModelCompatibilityFamily, inferModelFamily } from '@/lib/model-ui'
import type { CloudProject } from '@/api/deliveries'
import type { InstalledPlugin, LocalDeviceApp, LocalDeviceSkill, RuntimeWorkspaceSearchItem, UnifiedModel } from '@/types/api'
import type { ConversationMentionCandidate } from '@/lib/conversation-mentions'
import { displaySkillNameFromName, localSkillTestId } from './composerMentions'

type CommonTranslate = ReturnType<typeof useTranslation>['t']

export type ComposerMentionCandidate =
  | {
      kind: 'plugin'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      plugin: InstalledPlugin
    }
  | {
      kind: 'skill'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      skill: LocalDeviceSkill
    }
  | {
      kind: 'app'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      app: LocalDeviceApp
    }
  | {
      kind: 'cloud'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      statusLabel?: string
      project?: CloudProject
    }
  | {
      kind: 'conversation'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      conversation: ConversationMentionCandidate
    }

export type ComposerSkillMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'skill' }>
export type ComposerPluginMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'plugin' }>

export type MentionMenuRow =
  | { kind: 'candidate'; candidate: ComposerMentionCandidate }
  | { kind: 'plugin-skills-action'; plugin: ComposerPluginMentionCandidate }
  | { kind: 'plugin-back-action' }
  | { kind: 'path'; item: RuntimeWorkspaceSearchItem }
  | { kind: 'files-action' }
  | { kind: 'goal-action' }
  | { kind: 'plan-action' }
  | { kind: 'cloud-back-action' }
  | { kind: 'cloud-space-direct-action' }
  | { kind: 'cloud-projects-action' }

export function isMentionMenuRowEnabled(row: MentionMenuRow, canBrowseFiles: boolean): boolean {
  if (row.kind === 'candidate') return row.candidate.enabled
  if (row.kind === 'plugin-skills-action') return row.plugin.enabled
  return row.kind !== 'files-action' || canBrowseFiles
}

export function skillBelongsToPlugin(plugin: InstalledPlugin, skill: LocalDeviceSkill): boolean {
  const path = (value: string) => {
    const normalized = value
      .replaceAll('\\', '/')
      .replace(/\/$/, '')
      .replace(/\/SKILL\.md$/, '')
    return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
  }
  return plugin.spec.components.skills.some(
    component => component.path && path(component.path) === path(skill.path)
  )
}
export type ComposerAppMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'app' }>
export type ComposerCloudMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'cloud' }>
export type ComposerConversationMentionCandidate = Extract<
  ComposerMentionCandidate,
  { kind: 'conversation' }
>

export function matchesMentionQuery(candidate: ComposerMentionCandidate, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  const description = candidate.description || ''
  return (
    candidate.title.toLowerCase().includes(normalizedQuery) ||
    description.toLowerCase().includes(normalizedQuery) ||
    candidate.searchAliases.some(alias => alias.toLowerCase().includes(normalizedQuery))
  )
}

export function displaySkillName(skill: LocalDeviceSkill): string {
  return displaySkillNameFromName(skill.name)
}

export function displayAppName(app: LocalDeviceApp): string {
  return app.name || app.id
}

export function displaySkillSource(skill: LocalDeviceSkill, t: CommonTranslate): string {
  if (skill.source_label) return skill.source_label

  switch (skill.scope) {
    case 'user':
    case 'repo':
      return t('workbench.skill_scope_personal', 'Personal')
    case 'system':
    case 'admin':
      return t('workbench.skill_scope_system', 'System')
    default:
      break
  }

  if (skill.source === 'codex' || skill.source === 'codex-plugin') {
    return t('workbench.skill_scope_personal', 'Personal')
  }
  return skill.source
}

export function canSelectSkillForModel(
  skill: LocalDeviceSkill,
  selectedModel?: UnifiedModel | null
): boolean {
  // ls_skills normalizes every skill discovered by KCoder (built-in, user,
  // project and plugin) to this runtime source. Model vendors are not hosts.
  if (skill.source.trim().toLowerCase() === 'kcoder') return true
  if (!selectedModel) return true

  const runtime = inferSkillRuntime(selectedModel)
  if (runtime === 'claude') return isClaudeSkill(skill)
  if (runtime === 'codex') return isCodexSkill(skill)
  return skill.source === 'agents' || !isCodexSkill(skill)
}

function inferSkillRuntime(model: UnifiedModel): 'claude' | 'codex' | null {
  const provider = getModelConfigProvider(model)
  const runtimeFamily = getModelCompatibilityFamily(model)
  const runtimeProtocol = runtimeFamily?.split('.').filter(Boolean).at(-1) ?? ''
  const protocol = normalizeRuntimeSignal(model.config?.protocol)
  const apiFormat = normalizeRuntimeSignal(model.config?.apiFormat ?? model.config?.api_format)

  if (provider === 'claude' || runtimeProtocol === 'claude' || protocol === 'claude') {
    return 'claude'
  }
  if (
    provider === 'openai' ||
    runtimeProtocol === 'openai-responses' ||
    protocol === 'openai-responses' ||
    apiFormat === 'responses'
  ) {
    return 'codex'
  }

  const family = inferModelFamily(model)
  if (family === 'claude') return 'claude'
  if (family === 'gpt') return 'codex'
  return null
}

function getModelConfigProvider(model: UnifiedModel): string {
  const config = objectRecord(model.config)
  const directEnv = objectRecord(config?.env)
  const nestedModelConfig = objectRecord(config?.modelConfig)
  const nestedEnv = objectRecord(nestedModelConfig?.env)
  return (
    normalizeRuntimeSignal(model.runtime?.provider) ||
    normalizeRuntimeSignal(directEnv?.model) ||
    normalizeRuntimeSignal(nestedEnv?.model) ||
    normalizeRuntimeSignal(model.provider)
  )
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeRuntimeSignal(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isClaudeSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'claude' || skill.source === 'claude-plugin'
}

function isCodexSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'codex' || skill.source === 'codex-plugin'
}

export function slashSkillTestId(name: string): string {
  return `skill-${localSkillTestId(name)}`
}

export function slashAppTestId(id: string): string {
  return `app-${localSkillTestId(id)}`
}

export function dedupeLocalSkills(input: LocalDeviceSkill[]): LocalDeviceSkill[] {
  const deduped = new Map<string, LocalDeviceSkill>()
  input.forEach(skill => {
    const key = (skill.name || skill.path).trim().toLowerCase()
    const current = deduped.get(key)
    deduped.set(key, current ? preferLocalSkill(current, skill) : skill)
  })
  return Array.from(deduped.values())
}

function preferLocalSkill(left: LocalDeviceSkill, right: LocalDeviceSkill): LocalDeviceSkill {
  const leftRank = skillSourceRank(left)
  const rightRank = skillSourceRank(right)
  if (leftRank !== rightRank) return leftRank < rightRank ? left : right
  return (left.mtime ?? 0) >= (right.mtime ?? 0) ? left : right
}

function skillSourceRank(skill: LocalDeviceSkill): number {
  if (skill.source_priority !== undefined) return skill.source_priority
  if (skill.source === 'codex') return 0
  if (skill.source === 'codex-plugin') return 1
  return 2
}

export function skillReference(skill: LocalDeviceSkill): string {
  return localSkillReference(skill)
}

export function appReference(app: LocalDeviceApp): string {
  if (app.skillPath) return `[$${app.name || app.id}](${app.skillPath})`
  return `[$${app.name || app.id}](app://${app.id})`
}
