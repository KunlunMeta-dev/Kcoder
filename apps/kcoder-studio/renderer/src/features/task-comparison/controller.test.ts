import { describe, expect, it, vi } from 'vitest'
import {
  createTaskComparisonController,
  TASK_COMPARISON_METHODS,
  TaskComparisonError,
} from './controller'
import { comparisonFixture, comparisonScope, fixtureController } from './fixtures.test-support'

describe('task comparison target adapter', () => {
  it('does not send any request without a negotiated capability', async () => {
    const request = vi.fn()
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: false,
      request,
    })
    await expect(controller.read()).rejects.toMatchObject({ code: 'unsupported' })
    expect(request).not.toHaveBeenCalled()
  })
  it('checks the scope again after an awaited operation before accepting its output', async () => {
    let current = true
    let resolve!: (value: unknown) => void
    const request = vi.fn(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: true,
      request,
      isCurrent: () => current,
    })
    const pending = controller.read()
    current = false
    resolve(comparisonFixture())
    await expect(pending).rejects.toMatchObject({ code: 'scope_changed' })
  })
  it('accepts generated contracts only when owner, task, target and worktree identities agree', async () => {
    const good = comparisonFixture()
    const request = vi.fn(async () => good as unknown)
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: true,
      request,
    })
    expect(await controller.read()).toEqual(good)
    expect(request).toHaveBeenCalledWith(TASK_COMPARISON_METHODS.read, {
      deviceId: 'target-A',
      sourcePath: '/source',
      ownerThreadId: 'owner-A',
      comparisonId: 'requirement-A',
    })
    for (const changed of [
      { ...good, ownerThreadId: 'peer' },
      { ...good, deviceId: 'peer' },
      { ...good, sourcePath: '/peer' },
      { ...good, candidates: [good.candidates[0], good.candidates[0]] },
      { ...good, selectedThreadId: 'peer' },
      {
        ...good,
        candidates: [
          { ...good.candidates[0], binding: { ...good.candidates[0].binding, deviceId: 'peer' } },
        ],
      },
    ]) {
      request.mockResolvedValueOnce(changed)
      await expect(controller.read()).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
  it('binds the selected B identity and CAS fields without running or cleaning tasks', async () => {
    const chosen = comparisonFixture().candidates[1]
    const selected = await fixtureController().select(chosen)
    const request = vi.fn(async () => selected)
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: true,
      request,
    })
    expect((await controller.select(chosen)).selectedThreadId).toBe('thread-B')
    expect(request).toHaveBeenCalledExactlyOnceWith(TASK_COMPARISON_METHODS.select, {
      deviceId: 'target-A',
      sourcePath: '/source',
      ownerThreadId: 'owner-A',
      comparisonId: 'requirement-A',
      threadId: 'thread-B',
      expectedRevision: 3,
      expectedHeadCommit: 'b'.repeat(40),
      expectedContentToken: 'c'.repeat(64),
    })
  })
  it('preserves prepared worktrees when task acceptance is unknown and never retries a model call', async () => {
    const calls: string[] = []
    const request = vi.fn(async (method: string) => {
      calls.push(method)
      if (method === TASK_COMPARISON_METHODS.read) return comparisonFixture()
      if (method === 'runtime.worktrees.prepare')
        return { success: true, path: '/managed/C', worktree: {} }
      throw new Error('unexpected downstream operation')
    })
    const createTask = vi.fn(async () => {
      throw new Error('turn acceptance unknown')
    })
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: true,
      request,
      createTask,
    })
    await expect(
      controller.create({ label: 'C', branch: 'alternative/C', prompt: 'Use approach C' })
    ).rejects.toThrow('turn acceptance unknown')
    expect(createTask).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([TASK_COMPARISON_METHODS.read, 'runtime.worktrees.prepare'])
    expect(request).toHaveBeenLastCalledWith(
      'runtime.worktrees.prepare',
      expect.objectContaining({
        sourcePath: '/source',
        branch: 'alternative/C',
        ref: 'a'.repeat(40),
      })
    )
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'target-A',
        workspacePath: '/managed/C',
        title: 'C',
        prompt: 'Implement the same requirement\n\nUse approach C',
      })
    )
  })
  it('rejects foreign task links before reading or writing any target record', async () => {
    const request = vi.fn()
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: true,
      request,
    })
    await expect(
      controller.link(
        {
          deviceId: 'peer',
          taskId: 'task-B',
          threadId: 'thread-B',
          workspacePath: '/managed/B',
          title: 'B',
        },
        'B'
      )
    ).rejects.toBeInstanceOf(TaskComparisonError)
    expect(request).not.toHaveBeenCalled()
  })
  it('keeps a running created alternative associated when its current content proof is unavailable', async () => {
    const existing = comparisonFixture()
    const candidate = {
      ...existing.candidates[0],
      worktreeId: 'worktree-C',
      path: '/managed/C',
      revision: 3,
      binding: {
        ...existing.candidates[0].binding,
        label: 'C',
        taskId: 'task-C',
        threadId: 'thread-C',
        branch: 'alternative/C',
      },
      git: null,
      resultPreview: null,
      checks: [],
      evidencePartial: true,
      unavailable: ['git_unavailable'],
      usage: {
        assistantMessages: 0,
        usageSamples: 0,
        inputTokens: null,
        outputTokens: null,
        costMicrousd: null,
      },
    }
    const bound = { ...existing, candidates: [...existing.candidates, candidate] }
    const request = vi.fn(async (method: string) => {
      if (method === TASK_COMPARISON_METHODS.read) return existing
      if (method === 'runtime.worktrees.prepare') return { success: true, path: '/managed/C' }
      if (method === 'runtime.worktrees.list')
        return {
          success: true,
          items: [{ path: '/managed/C', sourcePath: '/source', revision: 2 }],
        }
      if (method === TASK_COMPARISON_METHODS.bind) return bound
      throw new Error('unexpected operation')
    })
    const createTask = vi.fn(async () => ({
      deviceId: 'target-A',
      taskId: 'task-C',
      threadId: 'thread-C',
      workspacePath: '/managed/C',
      title: 'C',
    }))
    const controller = createTaskComparisonController({
      scope: comparisonScope,
      supported: true,
      request,
      createTask,
    })
    const result = await controller.create({ label: 'C', branch: 'alternative/C', prompt: 'Use C' })
    expect(result.candidates.find(c => c.binding.threadId === 'thread-C')).toMatchObject({
      path: '/managed/C',
      git: null,
      evidencePartial: true,
    })
    expect(createTask).toHaveBeenCalledTimes(1)
    expect(request.mock.calls.map(call => call[0])).toEqual([
      TASK_COMPARISON_METHODS.read,
      'runtime.worktrees.prepare',
      'runtime.worktrees.list',
      TASK_COMPARISON_METHODS.bind,
    ])
    await expect(controller.select(candidate)).rejects.toMatchObject({ code: 'task_mismatch' })
    expect(request).toHaveBeenCalledTimes(4)
  })
})
