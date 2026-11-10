import type { TaskComparisonReadResult } from '../../../../shared/generated/contracts'
import type { TaskComparisonController, TaskComparisonScope } from './controller'

export const comparisonScope: TaskComparisonScope = {
  deviceId: 'target-A',
  sourcePath: '/source',
  ownerThreadId: 'owner-A',
  comparisonId: 'requirement-A',
  requirement: 'Implement the same requirement',
}
export function comparisonFixture(): TaskComparisonReadResult {
  return {
    ...comparisonScope,
    requirement: comparisonScope.requirement,
    selectedThreadId: null,
    candidates: ['A', 'B'].map((id, index) => ({
      worktreeId: `worktree-${id}`,
      path: `/managed/${id}`,
      sourcePath: '/source',
      revision: 3,
      state: 'active',
      binding: {
        comparisonId: 'requirement-A',
        ownerThreadId: 'owner-A',
        deviceId: 'target-A',
        requirement: comparisonScope.requirement,
        label: `Alternative ${id}`,
        taskId: `task-${id}`,
        threadId: `thread-${id}`,
        branch: `alternative/${id}`,
        baseCommit: 'a'.repeat(40),
        selection: null,
      },
      git: {
        headCommit: 'b'.repeat(40),
        branch: `alternative/${id}`,
        contentToken: 'c'.repeat(64),
        dirty: true,
        diffPreview: `+actual change ${id}`,
        statusPreview: ' M answer.txt\n?? keep-untracked.txt',
        truncated: false,
      },
      resultPreview:
        index === 0 ? 'Model says all checks passed.' : 'Alternative B completed its report.',
      checks:
        index === 0
          ? [
              {
                evidenceId: 'd'.repeat(64),
                turnId: 'turn-A',
                attemptId: 'attempt-A',
                ordinal: 1,
                command: 'cargo test focused',
                cwd: '/managed/A',
                outcome: 'failed',
                exitCode: 1,
                outputPreview: 'NATIVE_CHECK_FAILED',
                detailsTruncated: false,
              },
            ]
          : [],
      artifacts: [],
      evidencePartial: index !== 0,
      usage: {
        assistantMessages: 1,
        usageSamples: index === 0 ? 1 : 0,
        inputTokens: index === 0 ? 100 : null,
        outputTokens: index === 0 ? 20 : null,
        costMicrousd: null,
      },
      unavailable: [],
    })),
  }
}
export function fixtureController(
  overrides: Partial<TaskComparisonController> = {}
): TaskComparisonController {
  return {
    scope: comparisonScope,
    supported: true,
    canCreate: false,
    read: async () => comparisonFixture(),
    link: async () => comparisonFixture(),
    create: async () => comparisonFixture(),
    select: async candidate => ({
      ...comparisonFixture(),
      selectedThreadId: candidate.binding.threadId,
      candidates: comparisonFixture().candidates.map(c => ({
        ...c,
        binding: {
          ...c.binding,
          selection:
            c.binding.threadId === candidate.binding.threadId
              ? { headCommit: 'b'.repeat(40), contentToken: 'c'.repeat(64), selectedAtMs: 1 }
              : null,
        },
      })),
    }),
    ...overrides,
  }
}
