import type { RuntimeSourceAgent } from '@/types/subagents'

/** Source is a dedicated backend field. Freeform annotations never establish ownership. */
export function agentInteractionSource(
  value: unknown,
  parentThreadId: string
): RuntimeSourceAgent | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') throw new Error('invalid subagent interaction source')
  const source = value as Record<string, unknown>
  if (
    typeof source.agentId !== 'string' ||
    !source.agentId ||
    source.parentSessionId !== parentThreadId
  )
    throw new Error('subagent interaction parent identity conflict')
  if (source.backgroundRun !== undefined && source.backgroundRun !== null) {
    const run = source.backgroundRun as Record<string, unknown>
    if (
      !run ||
      typeof run !== 'object' ||
      run.agentId !== source.agentId ||
      run.parentSessionId !== parentThreadId ||
      typeof run.runId !== 'string' ||
      !run.runId
    )
      throw new Error('subagent interaction run identity conflict')
    return {
      agentId: source.agentId,
      parentSessionId: parentThreadId,
      backgroundRun: { agentId: source.agentId, parentSessionId: parentThreadId, runId: run.runId },
    }
  }
  return { agentId: source.agentId, parentSessionId: parentThreadId }
}
