import type {
  WorkflowCollaborationCatalogResult,
  WorkflowCollaborationMember,
  WorkflowCollaborationPlan,
  WorkflowCollaborationRole,
} from '../../../../../shared/generated/contracts'
export interface CollaborationForm {
  scheme: 'research_review' | 'draft_verify'
  objective: string
  criteria: string
  path: string
}
/** Produces the existing portable plan; native compilation owns the graph. */
export function buildCollaborationPlan(
  form: CollaborationForm,
  catalog: WorkflowCollaborationCatalogResult,
  titles: Partial<Record<WorkflowCollaborationRole, string>> = {}
): WorkflowCollaborationPlan {
  const criteria = form.criteria
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
  if (!form.objective.trim() || !criteria.length) throw new Error('required')
  if (
    form.scheme === 'draft_verify' &&
    (!form.path.trim() ||
      /(^[\\/]|[:*?[\]{}]|(^|\/)\.\.?($|\/))/.test(form.path) ||
      form.path.includes('\\'))
  )
    throw new Error('path')
  const member = (
    id: string,
    role: WorkflowCollaborationRole,
    dependsOn: string[]
  ): WorkflowCollaborationMember => {
    const preset = catalog.roles.find(item => item.role === role)
    if (!preset) throw new Error('unavailable')
    return {
      id,
      title: titles[role]
        ? `${titles[role]}${id.endsWith('_a') ? ' A' : id.endsWith('_b') ? ' B' : ''}`
        : id,
      role,
      instructions: `${preset.instructions}\nTask objective: ${form.objective.trim()}\nAcceptance criteria:\n${criteria.join('\n')}`,
      modelSelection: { mode: 'inherit_current' },
      inputBindings: { brief: '/input/brief' },
      dependsOn,
      allowedWritePaths: role === 'writer' ? [form.path.trim()] : [],
      acceptanceCriteria: criteria,
      artifactRequirements:
        role === 'writer'
          ? [
              {
                path: form.path.trim(),
                minBytes: 1,
                required: true,
                requireChanged: true,
                uniqueContent: true,
                forbiddenLiterals: [],
              },
            ]
          : [],
      outputSchema: structuredClone(preset.outputSchema),
      resultCheck: structuredClone(preset.resultCheck),
      maxTurns: 20,
    }
  }
  const members =
    form.scheme === 'research_review'
      ? [
          member('research_a', 'researcher', []),
          member('research_b', 'researcher', []),
          member('review', 'reviewer', ['research_a', 'research_b']),
          member('verify', 'verifier', ['review']),
        ]
      : [
          member('research', 'researcher', []),
          member('write', 'writer', ['research']),
          member('review', 'reviewer', ['write']),
          member('verify', 'verifier', ['review']),
        ]
  for (const current of members) {
    if (current.role === 'writer')
      current.instructions += `\nCreate and verify the actual artifact at ${form.path.trim()}. Inspect an existing file before modifying it.`
    for (const dependency of current.dependsOn ?? [])
      current.inputBindings[dependency] = `/nodes/${dependency}`
  }
  return {
    version: 1,
    inputSchema: {
      type: 'object',
      properties: { brief: { type: 'string', minLength: 1, description: form.objective.trim() } },
      required: ['brief'],
      additionalProperties: false,
    },
    members,
  }
}
