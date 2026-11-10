import type {
  OfficeAssistantDefinition,
  OfficeMarketExpert,
} from '../../../../shared/generated/contracts'
import appearance from '@/features/octop/market-presentation.json'
import defaultAvatar from '@/features/octop/assets/default-avatar.svg'

const builtinAvatars = import.meta.glob('../octop/assets/builtin/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>

export function expertAvatar(definition: OfficeAssistantDefinition): string | undefined {
  const meta = annotations(definition)
  if (
    typeof meta.avatar === 'string' &&
    meta.avatar.startsWith('data:image/webp;base64,') &&
    meta.avatar.length <= 8192
  )
    return meta.avatar
  if (meta.avatarPreset === 'generic') return defaultAvatar
  if (typeof meta.avatarPreset === 'string' && /^octop:[a-z0-9-]+\.svg$/.test(meta.avatarPreset))
    return builtinAvatars[`../octop/assets/builtin/${meta.avatarPreset.slice(6)}`]
  return undefined
}

export interface ExpertPresentation {
  color: string
  enabled: boolean
  kind: 'expert' | 'team'
  members: string[]
}
const colors = ['#6366f1', '#2563eb', '#10b981', '#f59e0b', '#e85d75', '#8b5cf6']
export { colors as expertColors }

/** JSON Schema annotations persist presentation with the same draft revision. */
export function expertPresentation(definition: OfficeAssistantDefinition): ExpertPresentation {
  const schema =
    definition.inputSchema &&
    typeof definition.inputSchema === 'object' &&
    !Array.isArray(definition.inputSchema)
      ? (definition.inputSchema as Record<string, unknown>)
      : {}
  const raw = schema['x-kcoder-expert'] as Partial<ExpertPresentation> | undefined
  return {
    color:
      typeof raw?.color === 'string' && /^#[a-fA-F0-9]{6}$/.test(raw.color) ? raw.color : '#6366f1',
    enabled: raw?.enabled !== false,
    kind: raw?.kind === 'team' ? 'team' : 'expert',
    members: Array.isArray(raw?.members)
      ? raw.members.filter((id): id is string => typeof id === 'string').slice(0, 64)
      : [],
  }
}
export function withPresentation(
  definition: OfficeAssistantDefinition,
  patch: Partial<ExpertPresentation>
) {
  const schema =
    definition.inputSchema &&
    typeof definition.inputSchema === 'object' &&
    !Array.isArray(definition.inputSchema)
      ? definition.inputSchema
      : { type: 'object' }
  return {
    ...definition,
    inputSchema: {
      ...schema,
      'x-kcoder-expert': {
        ...(((schema as Record<string, unknown>)['x-kcoder-expert'] as Record<string, unknown>) ??
          {}),
        ...expertPresentation(definition),
        ...patch,
      },
    },
  }
}
export function marketPresentation(item: OfficeMarketExpert, language: string) {
  const metadata = (
    appearance as Record<
      string,
      {
        color: string
        icon: string
        rank: number
        label: { zh: string; en: string }
        taskExamples: { zh?: string[]; en?: string[] }
      }
    >
  )[item.slug]
  return {
    color: metadata?.color ?? '#6366f1',
    rank: metadata?.rank ?? 999,
    title: metadata?.label[language.startsWith('zh') ? 'zh' : 'en'] ?? item.title,
    examples: metadata?.taskExamples[language.startsWith('zh') ? 'zh' : 'en'] ?? [],
  }
}

export function annotations(definition: OfficeAssistantDefinition): Record<string, unknown> {
  const schema = definition.inputSchema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const raw = (schema as Record<string, unknown>)['x-kcoder-expert']
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}
export function updateAnnotations(
  definition: OfficeAssistantDefinition,
  patch: Record<string, unknown>
) {
  const schema =
    definition.inputSchema &&
    typeof definition.inputSchema === 'object' &&
    !Array.isArray(definition.inputSchema)
      ? definition.inputSchema
      : {}
  return {
    ...definition,
    inputSchema: { ...schema, 'x-kcoder-expert': { ...annotations(definition), ...patch } },
  }
}
