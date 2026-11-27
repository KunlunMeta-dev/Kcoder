import type { TaskWorkspaceNativeRef } from '../../../../shared/generated/contracts'
import type { WorkflowRun } from './workflowApi'

export type FixedWorkflowRun = Extract<TaskWorkspaceNativeRef, { kind: 'workflow_run' }>

/** Original selectors are not authorization; the native reader still owns access. */
export function fixedWorkflowDefinition(reference: FixedWorkflowRun): string | null {
  const definition = reference.definitionRef
  if (
    reference.kind !== 'workflow_run' ||
    !reference.runId ||
    reference.runId.length > 256 ||
    !reference.threadId ||
    reference.threadId.length > 256 ||
    !Number.isSafeInteger(reference.revision) ||
    reference.revision < 1 ||
    !definition?.id ||
    definition.id.length > 256 ||
    !/^[1-9]\d*$/.test(definition.revision) ||
    !Number.isSafeInteger(Number(definition.revision))
  ) return null
  return definition.id
}

/** A live run may advance, but must never become another run, owner or definition. */
export function matchesFixedWorkflowRun(
  run: WorkflowRun,
  reference: FixedWorkflowRun,
  workspacePath?: string
): boolean {
  const definitionId = fixedWorkflowDefinition(reference)
  return Boolean(
    definitionId &&
    run.runId === reference.runId &&
    run.threadId === reference.threadId &&
    run.definitionId === definitionId &&
    run.version === Number(reference.definitionRef!.revision) &&
    Number.isSafeInteger(run.revision) &&
    run.revision >= reference.revision &&
    Array.isArray(run.nodeStates) &&
    run.nodeStates.length <= 4096 &&
    run.nodeStates.every(node =>
      typeof node.nodeId === 'string' && node.nodeId.length > 0 && node.nodeId.length <= 256 &&
      typeof node.status === 'string' && node.status.length <= 128 &&
      Number.isSafeInteger(node.attempt) && node.attempt >= 0 &&
      (node.iteration == null || Number.isSafeInteger(node.iteration) && node.iteration >= 0) &&
      typeof node.reused === 'boolean' &&
      (node.outputPreview == null || typeof node.outputPreview === 'string') &&
      (node.error == null || typeof node.error === 'string')
    ) &&
    (workspacePath === undefined || run.workspace === workspacePath)
  )
}
