/** Read-only state of the settings template a running session is bound to. */
export type SettingsTemplateBadgeStatus = 'current' | 'drifted' | 'missing'

export interface SettingsTemplateBadge {
  name: string
  status: SettingsTemplateBadgeStatus
}

export interface SettingsTemplateBindingLike {
  id: string
  revisionSha256: string
}

export function settingsTemplateBadgeState(
  binding: SettingsTemplateBindingLike | null | undefined,
  templates: Array<{ id: string; name: string; revisionSha256: string }> | null | undefined
): SettingsTemplateBadge | undefined {
  if (!binding || !templates) return undefined
  const match = templates.find(template => template.id === binding.id)
  if (!match) return { name: binding.id, status: 'missing' }
  return {
    name: match.name,
    status: match.revisionSha256 === binding.revisionSha256 ? 'current' : 'drifted',
  }
}
