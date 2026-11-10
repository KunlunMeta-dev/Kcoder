import type {
  TaskComparisonBindParams,
  TaskComparisonCandidate,
  TaskComparisonReadParams,
  TaskComparisonReadResult,
  TaskComparisonSelectParams,
} from '../../../../shared/generated/contracts'
import { isContract } from '../../../../shared/generated/validator.mjs'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { createRandomUuid } from '@/lib/random-id'

export const TASK_COMPARISON_CAPABILITY = 'taskComparisonV1'
export const TASK_COMPARISON_METHODS = {
  read: 'runtime.worktrees.comparison.read',
  bind: 'runtime.worktrees.comparison.bind',
  select: 'runtime.worktrees.comparison.select',
} as const

export interface TaskComparisonScope extends TaskComparisonReadParams {
  requirement: string
}
export interface ComparisonTask {
  deviceId: string
  taskId: string
  threadId: string
  workspacePath: string
  title: string
}
export interface CreateComparisonTaskInput {
  deviceId: string
  workspacePath: string
  creationRequestId: string
  title: string
  prompt: string
}
export type ComparisonErrorCode =
  'unsupported' | 'scope_changed' | 'invalid_response' | 'task_mismatch' | 'creation_unavailable'
export class TaskComparisonError extends Error {
  readonly code: ComparisonErrorCode
  constructor(code: ComparisonErrorCode) {
    super(code)
    this.code = code
  }
}
export interface TaskComparisonController {
  readonly scope: TaskComparisonScope
  readonly supported: boolean
  readonly canCreate: boolean
  read(): Promise<TaskComparisonReadResult>
  create(input: {
    label: string
    branch: string
    prompt: string
  }): Promise<TaskComparisonReadResult>
  link(task: ComparisonTask, label: string): Promise<TaskComparisonReadResult>
  select(candidate: TaskComparisonCandidate): Promise<TaskComparisonReadResult>
}
export function taskComparisonScopeKey(scope: TaskComparisonReadParams): string {
  return JSON.stringify([scope.deviceId, scope.sourcePath, scope.ownerThreadId, scope.comparisonId])
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function createTaskComparisonController(options: {
  scope: TaskComparisonScope
  supported: boolean
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  isCurrent?: () => boolean
  createTask?: (input: CreateComparisonTaskInput) => Promise<ComparisonTask>
}): TaskComparisonController {
  const scope = { ...options.scope }
  const address: TaskComparisonReadParams = {
    deviceId: scope.deviceId,
    sourcePath: scope.sourcePath,
    ownerThreadId: scope.ownerThreadId,
    comparisonId: scope.comparisonId,
  }
  const assertCurrent = () => {
    if (!options.supported) throw new TaskComparisonError('unsupported')
    if (options.isCurrent?.() === false) throw new TaskComparisonError('scope_changed')
  }
  const request = async (method: string, params: Record<string, unknown>) => {
    assertCurrent()
    const result = await options.request(method, params)
    assertCurrent()
    return result
  }
  const projection = (raw: unknown): TaskComparisonReadResult => {
    if (!isContract('TaskComparisonReadResult', raw))
      throw new TaskComparisonError('invalid_response')
    const result = raw as TaskComparisonReadResult
    if (
      result.deviceId !== scope.deviceId ||
      result.comparisonId !== scope.comparisonId ||
      result.ownerThreadId !== scope.ownerThreadId ||
      !sameWorkspacePath(result.sourcePath, scope.sourcePath) ||
      result.candidates.length > 8 ||
      result.candidates.some(
        candidate =>
          candidate.binding.deviceId !== scope.deviceId ||
          candidate.binding.comparisonId !== scope.comparisonId ||
          candidate.binding.ownerThreadId !== scope.ownerThreadId ||
          candidate.binding.requirement !== scope.requirement ||
          !sameWorkspacePath(candidate.sourcePath, scope.sourcePath)
      )
    )
      throw new TaskComparisonError('invalid_response')
    for (const field of ['path', 'threadId', 'taskId', 'branch'] as const) {
      const values = result.candidates.map(c => (field === 'path' ? c.path : c.binding[field]))
      if (new Set(values).size !== values.length) throw new TaskComparisonError('invalid_response')
    }
    if (
      result.selectedThreadId &&
      !result.candidates.some(
        c => c.binding.threadId === result.selectedThreadId && c.binding.selection
      )
    )
      throw new TaskComparisonError('invalid_response')
    return result
  }
  const read = async () => projection(await request(TASK_COMPARISON_METHODS.read, { ...address }))
  const worktree = async (path: string) => {
    const result = object(
      await request('runtime.worktrees.list', {
        deviceId: scope.deviceId,
        sourcePath: scope.sourcePath,
      })
    )
    const items = Array.isArray(result.items) ? result.items.map(object) : []
    const found = items.find(
      item => typeof item.path === 'string' && sameWorkspacePath(item.path, path)
    )
    if (
      !found ||
      typeof found.revision !== 'number' ||
      !Number.isSafeInteger(found.revision) ||
      typeof found.sourcePath !== 'string' ||
      !sameWorkspacePath(found.sourcePath, scope.sourcePath)
    ) {
      throw new TaskComparisonError('task_mismatch')
    }
    return { path: found.path as string, revision: found.revision }
  }
  const link = async (task: ComparisonTask, label: string) => {
    assertCurrent()
    if (
      task.deviceId !== scope.deviceId ||
      task.threadId === scope.ownerThreadId ||
      sameWorkspacePath(task.workspacePath, scope.sourcePath)
    )
      throw new TaskComparisonError('task_mismatch')
    const registered = await worktree(task.workspacePath)
    const params: TaskComparisonBindParams = {
      ...address,
      requirement: scope.requirement,
      label,
      path: registered.path,
      expectedRevision: registered.revision,
      taskId: task.taskId,
      threadId: task.threadId,
    }
    return projection(await request(TASK_COMPARISON_METHODS.bind, { ...params }))
  }
  return {
    scope,
    supported: options.supported,
    canCreate: !!options.createTask,
    read,
    link,
    async create(input) {
      assertCurrent()
      if (!options.createTask) throw new TaskComparisonError('creation_unavailable')
      const existing = await read()
      if (existing.candidates.length >= 8) throw new TaskComparisonError('invalid_response')
      const operationId = createRandomUuid()
      const prepared = object(
        await request('runtime.worktrees.prepare', {
          deviceId: scope.deviceId,
          sourcePath: scope.sourcePath,
          worktreeId: operationId,
          ref: existing.candidates[0]?.binding.baseCommit ?? 'HEAD',
          branch: input.branch,
        })
      )
      const path =
        typeof prepared.path === 'string' ? prepared.path : object(prepared.worktree).path
      if (
        prepared.success !== true ||
        typeof path !== 'string' ||
        sameWorkspacePath(path, scope.sourcePath)
      ) {
        throw new TaskComparisonError('invalid_response')
      }
      assertCurrent()
      // Existing task creation owns model choice, permissions and turn receipts.
      const task = await options.createTask({
        deviceId: scope.deviceId,
        workspacePath: path,
        creationRequestId: operationId,
        title: input.label,
        prompt: `${scope.requirement}\n\n${input.prompt}`,
      })
      assertCurrent()
      if (!sameWorkspacePath(task.workspacePath, path))
        throw new TaskComparisonError('task_mismatch')
      // A failed or unknown response preserves the worktree and task for explicit reconciliation.
      return link(task, input.label)
    },
    async select(candidate) {
      assertCurrent()
      if (
        !candidate.git ||
        candidate.binding.deviceId !== scope.deviceId ||
        candidate.binding.comparisonId !== scope.comparisonId ||
        candidate.binding.ownerThreadId !== scope.ownerThreadId ||
        !sameWorkspacePath(candidate.sourcePath, scope.sourcePath)
      )
        throw new TaskComparisonError('task_mismatch')
      const params: TaskComparisonSelectParams = {
        ...address,
        threadId: candidate.binding.threadId,
        expectedRevision: candidate.revision,
        expectedHeadCommit: candidate.git.headCommit,
        expectedContentToken: candidate.git.contentToken,
      }
      const result = projection(await request(TASK_COMPARISON_METHODS.select, { ...params }))
      if (result.selectedThreadId !== candidate.binding.threadId)
        throw new TaskComparisonError('invalid_response')
      return result
    },
  }
}
