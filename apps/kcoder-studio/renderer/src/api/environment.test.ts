import { describe, expect, test, vi } from 'vitest'
import type { DeviceCommandResponse } from '@/types/api'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import {
  buildPullRequestUrl,
  checkoutProjectBranch,
  commitAndPushProjectChanges,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
  loadProjectEnvironmentDiff,
  parseGitShortStat,
  pushProjectChanges,
  removeGitWorktree,
  workspaceHasUncommittedChanges,
} from './environment'

describe('parseGitShortStat', () => {
  test('extracts additions and deletions from git shortstat output', () => {
    expect(parseGitShortStat(' 10 files changed, 173 insertions(+), 13366 deletions(-)')).toEqual({
      additions: '+173',
      deletions: '-13366',
    })
  })

  test('detects a non-git workspace without depending on localized stderr', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: false,
      stdout: '',
      error: 'Command failed',
      stderr: 'fatal: 不是 git 仓库（或者任何父目录）：.git',
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 4,
        name: 'plain-cloud-workspace',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'device-456',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/plain-cloud-workspace',
          },
        },
      }
    )

    expect(info).toMatchObject({
      isGitRepository: false,
      deviceId: 'device-456',
      workspacePath: '/workspace/plain-cloud-workspace',
    })
    expect(info.error).toBeUndefined()
    expect(executeCommand).not.toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ command_key: 'git_remote_url' }))
    expect(executeCommand).toHaveBeenCalledWith('device-456', {
      command_key: 'git_is_worktree',
      path: '/workspace/plain-cloud-workspace',
      args: ['/workspace/plain-cloud-workspace'],
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('defaults missing additions and deletions to zero', () => {
    expect(parseGitShortStat('')).toEqual({ additions: '+0', deletions: '-0' })
  })

  test.each(['unexpected output', 'null'])(
    'does not mistake invalid shortstat %s for zero changes',
    value => {
      expect(parseGitShortStat(value)).toEqual({ additions: '', deletions: '' })
    }
  )

  test('does not present pending files as changed lines', () => {
    expect(parseGitShortStat(' 3 file(s) pending')).toEqual({
      additions: '',
      deletions: '',
    })
  })
})

describe('structured branch change statistics', () => {
  const comparison = { kind: 'merge-base', reference: 'origin/main', commit: 'a'.repeat(40) }
  const target = { deviceId: 'summary-device', path: '/workspace/feature' }
  const payload = { additions: 15, deletions: 2, fileCount: 4, binaryFiles: 1, comparison }
  function apiFor(stdout: DeviceCommandResponse['stdout']) {
    return {
      executeCommand: vi.fn(async (_: string, request: { command_key: string }) => ({
        success: true,
        stderr: '',
        stdout:
          request.command_key === 'git_branch_diff_shortstat'
            ? stdout
            : request.command_key === 'git_branch'
              ? 'feature/counts'
              : '',
      })),
    }
  }

  test('uses backend line totals and the actual base without adding file counts or reading porcelain', async () => {
    const api = apiFor(payload)
    const info = await loadProjectEnvironment(api, null, target)
    expect(info).toMatchObject({
      additions: '+15',
      deletions: '-2',
      branchName: 'feature/counts',
      changeSummary: { ...comparison, fileCount: 4, binaryFiles: 1 },
    })
    expect(api.executeCommand).toHaveBeenCalledTimes(3)
    expect(api.executeCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command_key: 'git_status_porcelain' })
    )
    info.changeSummary!.reference = 'mutated'
    expect((await loadProjectEnvironment(api, null, target)).changeSummary?.reference).toBe(
      'origin/main'
    )
  })

  test.each([false, true])('independent Git reads overlap without extra commands (legacy statistics: %s)', async legacy => {
    let finishStats!: (value: DeviceCommandResponse) => void
    let finishRemote!: (value: DeviceCommandResponse) => void
    const stats = new Promise<DeviceCommandResponse>(resolve => { finishStats = resolve })
    const remote = new Promise<DeviceCommandResponse>(resolve => { finishRemote = resolve })
    const executeCommand = vi.fn(async (_: string, request: { command_key: string }) => {
      if (request.command_key === 'git_branch_diff_shortstat') return stats
      if (request.command_key === 'git_remote_url') return remote
      return { success: true, stderr: '', stdout: request.command_key === 'git_branch'
        ? 'feature/counts' : '?? owned-untracked' }
    })
    const reading = loadProjectEnvironment({ executeCommand }, null, target)
    const summary = { success: true, stdout: legacy ? ' 1 file changed, 15 insertions(+), 2 deletions(-)' : payload, stderr: '' }
    try {
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith(target.deviceId,
        expect.objectContaining({ command_key: 'git_remote_url' })))
      finishStats(summary)
      if (legacy) await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith(target.deviceId,
        expect.objectContaining({ command_key: 'git_status_porcelain' })))
    } finally {
      finishStats(summary)
      finishRemote({ success: true, stdout: 'https://github.com/owned/environment.git', stderr: '' })
      await reading
    }
    expect(await reading).toMatchObject({ branchName: 'feature/counts', additions: '+15',
      createPullRequestUrl: 'https://github.com/owned/environment/compare/feature%2Fcounts?expand=1' })
    expect((await reading).untrackedFileCount).toBe(legacy ? 1 : undefined)
    expect(executeCommand).toHaveBeenCalledTimes(legacy ? 4 : 3)
  })

  test.each([
    { ...payload, additions: -1 },
    { ...payload, comparison: { ...comparison, reference: null } },
    { ...payload, comparison: { ...comparison, commit: 'unknown' } },
  ])('does not display invalid metadata as valid statistics', async invalid => {
    const info = await loadProjectEnvironment(apiFor(invalid), null, target)
    expect(info.additions).toBe('')
    expect(info.deletions).toBe('')
    expect(info.changeSummary).toBeUndefined()
    expect(info.error).toContain('Invalid Git change summary')
  })
})

describe('buildPullRequestUrl', () => {
  test('builds GitHub compare URL from https remote', () => {
    expect(
      buildPullRequestUrl(
        'https://github.com/wecode-ai/Wegent.git',
        'human/narwhal-20260528-073440'
      )
    ).toBe('https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1')
  })

  test('builds GitLab merge request URL from ssh remote', () => {
    expect(buildPullRequestUrl('git@gitlab.com:wecode-ai/Wegent.git', 'feature/context-info')).toBe(
      'https://gitlab.com/wecode-ai/Wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcontext-info'
    )
  })
})

describe('workspaceHasUncommittedChanges', () => {
  test('detects pending tracked and untracked worktree changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: ' M src/App.tsx\n?? notes.md\n',
      stderr: '',
    })

    await expect(
      workspaceHasUncommittedChanges({ executeCommand }, 'device-123', '/workspace/worktrees/9/app')
    ).resolves.toBe(true)

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_status_porcelain',
      path: '/workspace/worktrees/9/app',
      timeout_seconds: 10,
      max_output_bytes: 65536,
    })
  })

  test('removes clean worktrees through the device command API', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
    })

    await removeGitWorktree({ executeCommand }, 'device-123', '/workspace/worktrees/9/app')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_worktree_remove',
      path: '/workspace/worktrees/9/app',
      args: ['/workspace/worktrees/9/app', '/workspace/worktrees/9/app'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })
})

describe('loadProjectEnvironment', () => {
  test('isolates pending environment reads after an account change', async () => {
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldGate = new Promise<void>(resolve => {
      releaseOld = resolve
    })
    const newGate = new Promise<void>(resolve => {
      releaseNew = resolve
    })
    let calls = 0
    const executeCommand = vi.fn(async () => {
      const call = ++calls
      await (call <= 2 ? oldGate : newGate)
      return { success: true, stdout: '', stderr: '' }
    })
    const api = { executeCommand }
    const target = { deviceId: 'account-change-device', path: '/workspace' }
    const old = loadProjectEnvironment(api, null, target)
    const oldResult = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    notifyAccountContextChange(target.deviceId)
    const fresh = loadProjectEnvironment(api, null, target)
    await Promise.resolve()
    expect(executeCommand).toHaveBeenCalledTimes(4)
    releaseNew()
    await fresh
    const completedFreshCalls = executeCommand.mock.calls.length
    releaseOld()
    await oldResult
    expect(executeCommand).toHaveBeenCalledTimes(completedFreshCalls)
  })
  test.each(['project_workspace_root', 'git_branch', 'git_branch_diff_shortstat', 'git_status_porcelain', 'git_remote_url', 'git_is_worktree'])(
    'an account change during %s stops the remaining environment commands', async command => {
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { entered = resolve })
      const deviceId = `environment-owner-${command}`
      const executeCommand = vi.fn(async (_deviceId: string, data: { command_key: string }) => {
        if (data.command_key === command) { entered(); await gate }
        return {
          success: !(command === 'git_is_worktree' && data.command_key === 'git_branch'),
          stdout: data.command_key === 'project_workspace_root' ? '/workspace/projects'
            : data.command_key === 'git_branch' ? 'feature'
              : data.command_key === 'git_branch_diff_shortstat' ? ' 1 file changed, 2 insertions(+)' : '',
          stderr: '',
        }
      })
      const pending = loadProjectEnvironment({ executeCommand }, {
        id: 83, name: 'owned-environment', config: { execution: { deviceId },
          workspace: { source: 'git', checkoutPath: 'feature' } },
      })
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await started
      const calls = executeCommand.mock.calls.length
      notifyAccountContextChange(deviceId)
      release()
      await rejected
      expect(executeCommand).toHaveBeenCalledTimes(calls)
    }
  )
  test('reuses an unfinished environment read even after the cache TTL', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const executeCommand = vi.fn(async () => {
      await gate
      return { success: true, stdout: '', stderr: '' }
    })
    const api = { executeCommand }
    const target = { deviceId: 'slow-device', path: '/slow-workspace' }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const first = loadProjectEnvironment(api, null, target)
      await Promise.resolve()
      expect(executeCommand).toHaveBeenCalledTimes(2)
      clock.mockReturnValue(7000)
      const second = loadProjectEnvironment(api, null, target)
      await Promise.resolve()
      expect(executeCommand).toHaveBeenCalledTimes(2)
      release()
      expect(await second).toEqual(await first)
      expect(executeCommand).toHaveBeenCalledTimes(4)
    } finally {
      clock.mockRestore()
    }
  })
  test('resolves git checkout path to an absolute device workspace path', async () => {
    const outputs: Record<string, string> = {
      project_workspace_root: '/workspace/projects\n',
      git_branch: 'human/full-path-20260609\n',
      git_branch_diff_shortstat: ' 1 file changed, 2 insertions(+), 1 deletion(-)',
      git_status_porcelain: '',
      git_remote_url: 'https://github.com/wecode-ai/Wegent.git\n',
    }
    const executeCommand = vi.fn(async (_: string, data: { command_key: string }) => {
      expect(Object.hasOwn(outputs, data.command_key)).toBe(true)
      return { success: true, stdout: outputs[data.command_key], stderr: '' }
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'git',
            checkoutPath: 'directmessage_single',
          },
        },
      }
    )

    expect(info.additions).toBe('+2')
    expect(info.deletions).toBe('-1')
    expect(info.workspacePath).toBe('/workspace/projects/directmessage_single')
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'project_workspace_root',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      args: ['--json'],
      path: '/workspace/projects/directmessage_single',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('loads git info through the selected project device command API', async () => {
    const outputs: Record<string, string> = {
      git_branch: 'human/narwhal-20260528-073440\n',
      git_branch_diff_shortstat: ' 2 files changed, 8 insertions(+), 3 deletions(-)',
      git_status_porcelain: '',
      git_remote_url: 'https://github.com/wecode-ai/Wegent.git\n',
    }
    const executeCommand = vi.fn(async (_: string, data: { command_key: string }) => {
      expect(Object.hasOwn(outputs, data.command_key)).toBe(true)
      return { success: true, stdout: outputs[data.command_key], stderr: '' }
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info).toEqual({
      executionTarget: 'cloud',
      deviceId: 'device-123',
      workspacePath: '/workspace/Wegent',
      isGitRepository: true,
      branchName: 'human/narwhal-20260528-073440',
      additions: '+8',
      deletions: '-3',
      createPullRequestUrl:
        'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      args: ['--json'],
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('loads git info from the active workspace target', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'human/worktree-branch\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: ' 1 file changed, 4 insertions(+)',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'project-device',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      },
      {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/1029/Wegent',
        source: 'runtime',
      }
    )

    expect(info).toMatchObject({
      executionTarget: 'cloud',
      deviceId: 'runtime-device',
      branchName: 'human/worktree-branch',
      additions: '+4',
      deletions: '-0',
    })
    for (const commandKey of [
      'git_branch',
      'git_branch_diff_shortstat',
      'git_status_porcelain',
      'git_remote_url',
    ]) {
      expect(executeCommand).toHaveBeenCalledWith(
        'runtime-device',
        expect.objectContaining({
          command_key: commandKey,
          path: '/workspace/worktrees/1029/Wegent',
        })
      )
    }
  })

  test('surfaces structured stdout from text device commands as an environment error', async () => {
    const executeCommand = vi.fn(async (_: string, request: { command_key: string }) => ({
      success: true,
      stderr: '',
      stdout:
        request.command_key === 'git_branch'
          ? { branch: 'main' }
          : request.command_key === 'git_is_worktree'
            ? 'true'
            : '',
    }))

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 2,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info).toEqual({
      additions: '',
      deletions: '',
      executionTarget: 'local',
      deviceId: 'device-123',
      workspacePath: '/workspace/Wegent',
      error: 'Expected text stdout from device command',
    })
  })

  test('does not surface an error when the workspace is not a git repository', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 3,
        name: 'plain-workspace',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/plain-workspace',
          },
        },
      }
    )

    expect(info).toEqual({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local',
      isGitRepository: false,
      deviceId: 'device-123',
      workspacePath: '/workspace/plain-workspace',
    })
  })

  test('preserves git command errors when the workspace is a repository', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'fatal: failed to read git metadata',
        })
      }
      if (data.command_key === 'git_is_worktree') {
        return Promise.resolve({
          success: true,
          stdout: 'true\n',
          stderr: '',
        })
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 5,
        name: 'broken-repository',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/broken-repository',
          },
        },
      }
    )

    expect(info).toMatchObject({
      deviceId: 'device-123',
      workspacePath: '/workspace/broken-repository',
      error: 'fatal: failed to read git metadata',
    })
    expect(info.isGitRepository).toBeUndefined()
  })

  test('deduplicates repeated environment loads for the same project briefly', async () => {
    let statisticsReads = 0
    const outputs: Record<string, string> = {
      git_branch: 'human/narwhal-20260528-073440\n',
      git_status_porcelain: '',
      git_remote_url: 'https://github.com/wecode-ai/Wegent.git\n',
    }
    const executeCommand = vi.fn(async (_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch_diff_shortstat') return { success: true, stderr: '',
        stdout: ++statisticsReads === 1 ? ' 2 files changed, 8 insertions(+), 3 deletions(-)'
          : ' 3 files changed, 13 insertions(+), 5 deletions(-)' }
      expect(Object.hasOwn(outputs, data.command_key)).toBe(true)
      return { success: true, stdout: outputs[data.command_key], stderr: '' }
    })

    const api = { executeCommand }
    const project = {
      id: 1001,
      name: 'Wegent',
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-123',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/Wegent',
        },
      },
    }

    const [firstInfo, secondInfo] = await Promise.all([
      loadProjectEnvironment(api, project),
      loadProjectEnvironment(api, project),
    ])

    expect(firstInfo).toEqual(secondInfo)
    expect(firstInfo).not.toBe(secondInfo)
    firstInfo.branchName = 'mutated'

    const cachedInfo = await loadProjectEnvironment(api, project)

    expect(cachedInfo.branchName).toBe('human/narwhal-20260528-073440')
    // 4 calls: git_branch, git_branch_diff_shortstat, git_status_porcelain, git_remote_url
    expect(executeCommand).toHaveBeenCalledTimes(4)
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      args: ['--json'],
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_status_porcelain',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_remote_url',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })

    const refreshedInfo = await loadProjectEnvironment(api, project, undefined, { force: true })

    expect(refreshedInfo).toMatchObject({ additions: '+13', deletions: '-5' })
    expect(executeCommand).toHaveBeenCalledTimes(8)
  })

  test('uses git diff against HEAD for tracked uncommitted changes', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'feature/context-info\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: true,
          stdout: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
          stderr: '',
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info.additions).toBe('+1')
    expect(info.deletions).toBe('-1')
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      args: ['--json'],
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('keeps legacy untracked file counts separate from line totals', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'main\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: true,
          stdout: ' 1 file changed, 5 insertions(+), 2 deletions(-)',
          stderr: '',
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '?? output.txt\n?? notes.md\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'No such remote',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info.untrackedFileCount).toBe(2)
    expect(info.changeSummary).toBeUndefined()
    expect(info.additions).toBe('+5')
    expect(info.deletions).toBe('-2')
    expect(info.branchName).toBe('main')
  })

  test('shows unknown line totals when a legacy backend cannot compare an unborn branch', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'master\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: "fatal: bad revision 'HEAD'",
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '?? output.txt\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'No such remote',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 2,
        name: 'empty-repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/Volumes/OuterHD/Documents/test-porject',
          },
        },
      }
    )

    expect(info.additions).toBe('')
    expect(info.deletions).toBe('')
    expect(info.untrackedFileCount).toBe(1)
    expect(info.branchName).toBe('master')
    expect(info.error).toContain('HEAD')
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_status_porcelain',
      path: '/Volumes/OuterHD/Documents/test-porject',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('does not mistake failed statistics for a clean worktree', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'main\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: "fatal: bad revision 'HEAD'",
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'No such remote',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 3,
        name: 'clean-repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/tmp/clean-repo',
          },
        },
      }
    )

    expect(info.additions).toBe('')
    expect(info.deletions).toBe('')
    expect(info.error).toContain('HEAD')
  })
})

describe('commitProjectChanges', () => {
  test('loads the full environment diff through the project device command API', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: 'diff --git a/src/env.ts b/src/env.ts\n+new\n',
      stderr: '',
    })

    await expect(
      loadProjectEnvironmentDiff(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'device-123',
            },
            workspace: {
              source: 'local_path',
              localPath: '/workspace/Wegent',
            },
          },
        }
      )
    ).resolves.toBe('diff --git a/src/env.ts b/src/env.ts\n+new')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('loads the full environment diff from the active workspace target', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
    })

    await expect(
      loadProjectEnvironmentDiff(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'device-123',
            },
            workspace: {
              source: 'local_path',
              localPath: '/workspace/Wegent',
            },
          },
        },
        {
          deviceId: 'device-123',
          path: '/workspace/worktrees/1029/Wegent',
        }
      )
    ).resolves.toBe('')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('stages all changes and commits with the provided message', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })

    await commitProjectChanges(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      },
      'feat: update environment info'
    )

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_commit_all',
      path: '/workspace/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('stages and commits changes in the active workspace target', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })

    await commitProjectChanges(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'project-device',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      },
      'feat: update environment info',
      {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/1029/Wegent',
        source: 'runtime',
      }
    )

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'runtime-device', {
      command_key: 'git_commit_all',
      path: '/workspace/worktrees/1029/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('generates a commit message before committing when the provided message is empty', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: 'diff --git a/src/env.ts b/src/env.ts\n' })
      .mockResolvedValueOnce({
        success: true,
        stdout: { success: true, message: 'feat: update environment info' },
        stderr: '',
      })
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })

    await commitProjectChanges(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: { targetType: 'local', deviceId: 'device-123' },
          workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
        },
      },
      '   '
    )

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_add_all',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_diff_staged',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'device-123', {
      command_key: 'git_generate_commit_message',
      path: '/workspace/Wegent',
      timeout_seconds: 120,
      max_output_bytes: 8192,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(4, 'device-123', {
      command_key: 'git_commit_all',
      path: '/workspace/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('does not ask AI for a message when staging leaves no changes', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })

    await expect(
      commitProjectChanges(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: { targetType: 'local', deviceId: 'device-123' },
            workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
          },
        },
        ''
      )
    ).rejects.toThrow('No changes to commit')

    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(executeCommand).not.toHaveBeenCalledWith(
      'device-123',
      expect.objectContaining({ command_key: 'git_generate_commit_message' })
    )
  })

  test('shows git stdout when a clean repository rejects an explicit commit', async () => {
    const executeCommand = vi.fn().mockResolvedValueOnce({
      success: false,
      exit_code: 1,
      stdout: 'On branch main\nnothing to commit, working tree clean\n',
      stderr: '',
    })

    await expect(
      commitProjectChanges(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: { targetType: 'local', deviceId: 'device-123' },
            workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
          },
        },
        'test: explicit message'
      )
    ).rejects.toThrow('nothing to commit, working tree clean')
  })

  test('rejects invalid generated commit messages before running git commit', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: 'diff --git a/src/env.ts b/src/env.ts\n' })
      .mockResolvedValueOnce({
        success: true,
        stdout: { success: false, error: 'Codex auth is missing' },
        stderr: '',
      })

    await expect(
      commitProjectChanges(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: { targetType: 'local', deviceId: 'device-123' },
            workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
          },
        },
        ''
      )
    ).rejects.toThrow('Codex auth is missing')

    expect(executeCommand).toHaveBeenCalledTimes(3)
  })

  test('rejects a false-success commit when workspace changes remain', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: ' M src/env.ts\n', stderr: '' })

    await expect(
      commitProjectChanges({ executeCommand }, null, 'test: verify commit', {
        deviceId: 'device-123',
        path: '/workspace/Wegent',
        source: 'runtime',
      })
    ).rejects.toThrow('Git commit returned without committing all workspace changes')
  })
})

describe('pushProjectChanges', () => {
  const project = {
    id: 1,
    name: 'Wegent',
    config: {
      mode: 'workspace',
      execution: { targetType: 'local' as const, deviceId: 'device-123' },
      workspace: { source: 'local_path' as const, localPath: '/workspace/Wegent' },
    },
  }

  test('pushes the current branch through the project device command API', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: 'Everything up-to-date\n',
      stderr: '',
    })

    await pushProjectChanges({ executeCommand }, project)

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_push',
      path: '/workspace/Wegent',
      timeout_seconds: 120,
      max_output_bytes: 8192,
    })
  })

  test('commits and then pushes changes', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: 'pushed\n', stderr: '' })

    await commitAndPushProjectChanges({ executeCommand }, project, 'feat: update environment info')

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_commit_all',
      path: '/workspace/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_status_porcelain',
      path: '/workspace/Wegent',
      timeout_seconds: 15,
      max_output_bytes: 65536,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'device-123', {
      command_key: 'git_push',
      path: '/workspace/Wegent',
      timeout_seconds: 120,
      max_output_bytes: 8192,
    })
  })
})

describe('branch environment commands', () => {
  const project = {
    id: 1,
    name: 'Wegent',
    config: {
      mode: 'workspace',
      execution: { targetType: 'local' as const, deviceId: 'device-123' },
      workspace: { source: 'local_path' as const, localPath: '/workspace/Wegent' },
    },
  }

  test('lists branches with the current branch first', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_branch_list') {
        return {
          success: true,
          stdout: 'human/zebra\nmain\nhuman/alpaca\n',
          stderr: '',
        }
      }
      if (data.command_key === 'git_branch') {
        return { success: true, stdout: 'human/zebra\n', stderr: '' }
      }
      return { success: false, stdout: '', stderr: 'unexpected command' }
    })

    await expect(listProjectBranches({ executeCommand }, project)).resolves.toEqual([
      'human/zebra',
      'main',
      'human/alpaca',
    ])
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_branch_list',
      path: '/workspace/Wegent',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 64,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('runs branch commands in the active workspace target', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_branch_list') {
        return {
          success: true,
          stdout: 'main\n',
          stderr: '',
        }
      }
      if (data.command_key === 'git_branch') {
        return { success: true, stdout: 'main\n', stderr: '' }
      }
      return { success: true, stdout: '', stderr: '' }
    })
    const target = {
      deviceId: 'runtime-device',
      path: '/workspace/worktrees/1029/Wegent',
      source: 'runtime' as const,
    }

    await expect(listProjectBranches({ executeCommand }, project, target)).resolves.toEqual([
      'main',
    ])
    await checkoutProjectBranch({ executeCommand }, project, 'human/alpaca', target)
    await createAndCheckoutProjectBranch({ executeCommand }, project, 'human/new-branch', target)

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'runtime-device', {
      command_key: 'git_branch_list',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 64,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'runtime-device', {
      command_key: 'git_branch',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'runtime-device', {
      command_key: 'git_checkout',
      path: '/workspace/worktrees/1029/Wegent',
      args: ['human/alpaca'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(4, 'runtime-device', {
      command_key: 'git_checkout_new',
      path: '/workspace/worktrees/1029/Wegent',
      args: ['human/new-branch'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('checks out an existing branch', async () => {
    const executeCommand = vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '' })

    await checkoutProjectBranch({ executeCommand }, project, 'human/alpaca')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_checkout',
      path: '/workspace/Wegent',
      args: ['human/alpaca'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('creates and checks out a new branch', async () => {
    const executeCommand = vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '' })

    await createAndCheckoutProjectBranch({ executeCommand }, project, 'human/new-branch')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_checkout_new',
      path: '/workspace/Wegent',
      args: ['human/new-branch'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('rejects invalid branch names before running checkout commands', async () => {
    const executeCommand = vi.fn()

    await expect(checkoutProjectBranch({ executeCommand }, project, '-bad')).rejects.toThrow(
      'Invalid branch name'
    )
    await expect(
      createAndCheckoutProjectBranch({ executeCommand }, project, 'feature/bad..name')
    ).rejects.toThrow('Invalid branch name')

    expect(executeCommand).not.toHaveBeenCalled()
  })
})


function resolvedEnvironmentFixture() {
  const executeCommand = vi.fn(async (_device: string, data: { command_key: string }) => ({
    success: true, stderr: '', stdout: data.command_key === 'git_branch' ? 'owned-branch'
      : data.command_key === 'git_branch_diff_shortstat' ? {
        additions: 2, deletions: 1, fileCount: 1, binaryFiles: 0,
        comparison: { kind: 'empty', reference: null, commit: null },
      } : '',
  }))
  const api = { executeCommand }
  const target = { deviceId: 'resolved-owner', path: '/owned/workspace', source: 'project' as const }
  const project = { id: 801, name: 'Draft presentation', config: {
    execution: { deviceId: 'unused-project-default', targetType: 'local' as const },
    workspace: { source: 'local_path' as const, localPath: '/unused-project-default' },
  } }
  return { executeCommand, api, target, project }
}

test('resolved workspace projections share Git facts across draft/project/runtime presentation', async () => {
  const { executeCommand, api, target, project } = resolvedEnvironmentFixture()
  const results = await Promise.all([
    loadProjectEnvironment(api, project, target),
    loadProjectEnvironment(api, { ...project, id: 802, name: 'Runtime presentation' }, { ...target, source: 'runtime' }),
    loadProjectEnvironment(api, null, { ...target, source: 'runtime' }),
  ])
  expect(executeCommand).toHaveBeenCalledTimes(3)
  expect(results).toEqual(results.map(() => expect.objectContaining({
    deviceId: target.deviceId, workspacePath: target.path, branchName: 'owned-branch', additions: '+2', deletions: '-1',
  })))
  expect(results[0]).not.toBe(results[1])
  results[0].branchName = 'local-display-only'
  expect(results[1].branchName).toBe('owned-branch')
  await loadProjectEnvironment(api, project, { ...target, source: 'runtime' })
  expect(executeCommand).toHaveBeenCalledTimes(3)
  await loadProjectEnvironment(api, project, target, { force: true })
  expect(executeCommand).toHaveBeenCalledTimes(6)
})


test.each(['device', 'workspace', 'display-type', 'api'] as const)(
  'resolved environment reads retain their %s boundary', async boundary => {
    const f = resolvedEnvironmentFixture()
    await loadProjectEnvironment(f.api, f.project, f.target)
    const target = { ...f.target,
      ...(boundary === 'device' ? { deviceId: 'another-device' } : {}),
      ...(boundary === 'workspace' ? { path: '/another-workspace' } : {}),
    }
    const project = { ...f.project, config: { ...f.project.config, execution: {
      ...f.project.config.execution, targetType: boundary === 'display-type' ? 'cloud' as const : 'local' as const,
    } } }
    const result = await loadProjectEnvironment(boundary === 'api' ? { executeCommand: f.executeCommand } : f.api,
      project, target)
    expect(f.executeCommand).toHaveBeenCalledTimes(6)
    expect(result).toMatchObject({ deviceId: target.deviceId, workspacePath: target.path,
      executionTarget: project.config.execution.targetType })
  }
)


test.each(['success', 'failed', 'unknown'] as const)('Git mutation %s retires cached observations without replay', async outcome => {
  const f = resolvedEnvironmentFixture(), original = f.executeCommand.getMockImplementation()!
  let branch = 'before-write'
  const lost = new GatewayRpcError('owned receipt lost', -1, undefined, 'runtime-session', 'unknown')
  f.executeCommand.mockImplementation(async (deviceId, data) => {
    if (data.command_key === 'git_branch') return { success: true, stderr: '', stdout: branch }
    if (data.command_key === 'git_checkout') {
      branch = 'after-write'
      if (outcome === 'unknown') throw lost
      return { success: outcome === 'success', stderr: outcome === 'failed' ? 'partial checkout failed' : '', stdout: '' }
    }
    return original(deviceId, data)
  })
  expect((await loadProjectEnvironment(f.api, f.project, f.target)).branchName).toBe('before-write')
  const operation = checkoutProjectBranch(f.api, f.project, 'after-write', f.target)
  if (outcome === 'success') await operation
  else if (outcome === 'unknown') await expect(operation).rejects.toBe(lost)
  else await expect(operation).rejects.toThrow('partial checkout failed')
  expect((await loadProjectEnvironment(f.api, f.project, f.target)).branchName).toBe('after-write')
  expect(f.executeCommand.mock.calls.filter(([, data]) => data.command_key === 'git_checkout')).toHaveLength(1)
})

test('a pre-write pending Git observation retires before dispatching its remaining commands', async () => {
  const f = resolvedEnvironmentFixture(), original = f.executeCommand.getMockImplementation()!
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  f.executeCommand.mockImplementation(async (deviceId, data) => {
    if (data.command_key === 'git_branch') { started(); await gate }
    return original(deviceId, data)
  })
  const pending = loadProjectEnvironment(f.api, f.project, f.target)
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  try {
    await entered
    await checkoutProjectBranch(f.api, f.project, 'after-write', f.target)
    const beforeRelease = f.executeCommand.mock.calls.length
    release()
    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
    expect(f.executeCommand).toHaveBeenCalledTimes(beforeRelease)
  } finally { release(); await outcome }
})


test.each(['checkout', 'create', 'commit', 'stage', 'push', 'remove-worktree'] as const)(
  '%s invalidates every display variant of its actual workspace', async action => {
    const f = resolvedEnvironmentFixture()
    await loadProjectEnvironment(f.api, f.project, f.target)
    if (action === 'checkout') await checkoutProjectBranch(f.api, f.project, 'next', f.target)
    else if (action === 'create') await createAndCheckoutProjectBranch(f.api, f.project, 'next', f.target)
    else if (action === 'commit') await commitProjectChanges(f.api, f.project, 'message', f.target)
    else if (action === 'stage') await expect(commitProjectChanges(f.api, f.project, '', f.target)).rejects.toThrow('No changes to commit')
    else if (action === 'push') await pushProjectChanges(f.api, f.project, f.target)
    else await removeGitWorktree(f.api, f.target.deviceId, f.target.path)
    const before = f.executeCommand.mock.calls.length
    await loadProjectEnvironment(f.api, { ...f.project, id: 999 }, { ...f.target, source: 'runtime' })
    expect(f.executeCommand).toHaveBeenCalledTimes(before + 3)
  }
)

test.each(['resolved', 'project-only'] as const)('a write preserves unrelated %s workspace observations', async mode => {
  const f = resolvedEnvironmentFixture()
  const otherProject = { ...f.project, id: 2, config: { ...f.project.config,
    execution: { ...f.project.config.execution, deviceId: f.target.deviceId },
    workspace: { source: 'local_path' as const, localPath: '/other-workspace' },
  } }
  const otherTarget = mode === 'resolved' ? { ...f.target, path: '/other-workspace' } : undefined
  const other = await loadProjectEnvironment(f.api, otherProject, otherTarget)
  await checkoutProjectBranch(f.api, f.project, 'next', f.target)
  const before = f.executeCommand.mock.calls.length
  expect(await loadProjectEnvironment(f.api, otherProject, otherTarget)).toEqual(other)
  expect(f.executeCommand).toHaveBeenCalledTimes(before)
})

test('a superseded pending reader still retires when a forced peer occupies its cache slot', async () => {
  const f = resolvedEnvironmentFixture(), original = f.executeCommand.getMockImplementation()!
  let release!: () => void, entered!: () => void, branches = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  f.executeCommand.mockImplementation(async (deviceId, data) => {
    if (data.command_key === 'git_branch' && ++branches === 1) { entered(); await gate }
    return original(deviceId, data)
  })
  const pending = loadProjectEnvironment(f.api, f.project, f.target)
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  try {
    await started
    await loadProjectEnvironment(f.api, f.project, f.target, { force: true })
    await checkoutProjectBranch(f.api, f.project, 'next', f.target)
    const before = f.executeCommand.mock.calls.length
    release()
    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
    expect(f.executeCommand).toHaveBeenCalledTimes(before)
  } finally { release(); await outcome }
})

test('a mutation completion from a retired account leaves the replacement account cache alone', async () => {
  const f = resolvedEnvironmentFixture(), original = f.executeCommand.getMockImplementation()!
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  f.executeCommand.mockImplementation(async (deviceId, data) => {
    if (data.command_key === 'git_checkout') { entered(); await gate }
    return original(deviceId, data)
  })
  const operation = checkoutProjectBranch(f.api, f.project, 'next', f.target)
  try {
    await started
    notifyAccountContextChange(f.target.deviceId)
    await loadProjectEnvironment(f.api, f.project, f.target)
    release(); await operation
    const before = f.executeCommand.mock.calls.length
    await loadProjectEnvironment(f.api, f.project, f.target)
    expect(f.executeCommand).toHaveBeenCalledTimes(before)
  } finally { release(); await operation }
})


test('a pending write fences both the previous cache and observations completed during that write', async () => {
  const f = resolvedEnvironmentFixture(), original = f.executeCommand.getMockImplementation()!
  let branch = 'before', release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  f.executeCommand.mockImplementation(async (deviceId, data) => {
    if (data.command_key === 'git_branch') return { success: true, stderr: '', stdout: branch }
    if (data.command_key === 'git_checkout') { entered(); await gate; branch = 'after' }
    return original(deviceId, data)
  })
  await loadProjectEnvironment(f.api, f.project, f.target)
  const operation = checkoutProjectBranch(f.api, f.project, 'after', f.target)
  try {
    await started
    expect((await loadProjectEnvironment(f.api, f.project, f.target)).branchName).toBe('before')
    expect(f.executeCommand.mock.calls.filter(([, data]) => data.command_key === 'git_branch')).toHaveLength(2)
    release(); await operation
    expect((await loadProjectEnvironment(f.api, f.project, f.target)).branchName).toBe('after')
    expect(f.executeCommand.mock.calls.filter(([, data]) => data.command_key === 'git_branch')).toHaveLength(3)
    expect(f.executeCommand.mock.calls.filter(([, data]) => data.command_key === 'git_checkout')).toHaveLength(1)
  } finally { release(); await operation }
})

test.each(['project_workspace_root', 'git_branch', 'git_branch_diff_shortstat', 'git_remote_url', 'git_is_worktree'] as const)(
  'a Native cancellation at %s stops the old environment pipeline', async command => {
    const f = resolvedEnvironmentFixture(), original = f.executeCommand.getMockImplementation()!
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    f.executeCommand.mockImplementation(async (deviceId, data) => {
      if (command === 'git_is_worktree' && data.command_key === 'git_branch')
        return { success: false, stderr: 'ordinary Git failure', stdout: '' }
      if (data.command_key === command) { entered(); await gate; throw new DOMException('Native source retired', 'AbortError') }
      return original(deviceId, data)
    })
    const pending = command === 'project_workspace_root'
      ? loadProjectEnvironment(f.api, { ...f.project, config: {
        execution: { deviceId: f.target.deviceId }, workspace: { source: 'git', checkoutPath: 'owned' },
      } }) : loadProjectEnvironment(f.api, f.project, f.target)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    try {
      await started
      if (command === 'git_branch_diff_shortstat')
        await vi.waitFor(() => expect(f.executeCommand.mock.calls.some(([, data]) => data.command_key === 'git_remote_url')).toBe(true))
      const before = f.executeCommand.mock.calls.length
      release()
      expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
      expect(f.executeCommand).toHaveBeenCalledTimes(before)
    } finally { release(); await outcome }
  }
)

test.each(['diff', 'branches', 'dirty'] as const)('a delayed %s result cannot publish after its account changes', async kind => {
  const f = resolvedEnvironmentFixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.executeCommand.mockImplementation(async () => {
    await gate
    return { success: true, stdout: 'before-account-change', stderr: '' }
  })
  const read = kind === 'diff' ? loadProjectEnvironmentDiff(f.api, f.project, f.target)
    : kind === 'branches' ? listProjectBranches(f.api, f.project, f.target)
      : workspaceHasUncommittedChanges(f.api, f.target.deviceId, f.target.path)
  const outcome = read.then(value => ({ value }), error => ({ error }))
  try {
    await vi.waitFor(() => expect(f.executeCommand).toHaveBeenCalledTimes(kind === 'branches' ? 2 : 1))
    notifyAccountContextChange(f.target.deviceId)
    release()
    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
  } finally { release(); await outcome }
})

test.each(['diff', 'branches'] as const)('an account change during %s root lookup stops the remaining Git commands', async kind => {
  const f = resolvedEnvironmentFixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.executeCommand.mockImplementation(async (_device, request) => {
    if (request.command_key === 'project_workspace_root') await gate
    return { success: true, stdout: '/owned/root', stderr: '' }
  })
  const project = { ...f.project, config: { execution: { deviceId: f.target.deviceId },
    workspace: { source: 'git' as const, checkoutPath: 'project' } } }
  const read = kind === 'diff' ? loadProjectEnvironmentDiff(f.api, project) : listProjectBranches(f.api, project)
  const outcome = read.then(value => ({ value }), error => ({ error }))
  try {
    await vi.waitFor(() => expect(f.executeCommand).toHaveBeenCalledTimes(1))
    notifyAccountContextChange(f.target.deviceId)
    release()
    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
    expect(f.executeCommand).toHaveBeenCalledTimes(1)
  } finally { release(); await outcome }
})

test('a cancelled optional current-branch read cannot publish a successful stale branch directory', async () => {
  const f = resolvedEnvironmentFixture()
  f.executeCommand.mockImplementation(async (_device, request) => {
    if (request.command_key === 'git_branch') throw new DOMException('Native observation retired', 'AbortError')
    return { success: true, stdout: 'owned-branch\n', stderr: '' }
  })
  await expect(listProjectBranches(f.api, f.project, f.target)).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.executeCommand).toHaveBeenCalledTimes(2)
})

test('an ordinary optional branch failure and an unrelated account change preserve the current directory', async () => {
  const f = resolvedEnvironmentFixture()
  f.executeCommand.mockImplementation(async (_device, request) => {
    if (request.command_key === 'git_branch') throw new Error('Current branch unavailable')
    notifyAccountContextChange('other-environment-device')
    return { success: true, stdout: 'feature/owned\nmain', stderr: '' }
  })
  await expect(listProjectBranches(f.api, f.project, f.target)).resolves.toEqual(['feature/owned', 'main'])
  await expect(listProjectBranches(f.api, f.project, f.target)).resolves.toEqual(['feature/owned', 'main'])
  expect(f.executeCommand).toHaveBeenCalledTimes(4)
})

test('a failed detail read from an old account retires without replacing the original current-account error contract', async () => {
  const f = resolvedEnvironmentFixture(), failure = new GatewayRpcError('owned read denied', -32001)
  let reject!: (error: unknown) => void
  f.executeCommand.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const read = loadProjectEnvironmentDiff(f.api, f.project, f.target)
  const outcome = read.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(f.executeCommand).toHaveBeenCalledTimes(1))
  notifyAccountContextChange(f.target.deviceId)
  reject(failure)
  expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
  f.executeCommand.mockRejectedValueOnce(failure)
  await expect(loadProjectEnvironmentDiff(f.api, f.project, f.target)).rejects.toBe(failure)
})


describe('environment summary and action details', () => {
  const target = { deviceId: 'detail-projection', path: '/owned/details' }
  function fixture() {
    return { executeCommand: vi.fn(async (_: string, request: { command_key: string }) => ({ success: true, stderr: '', stdout:
      request.command_key === 'git_branch' ? 'feature/details' : request.command_key === 'git_remote_url' ? 'https://github.com/owned/details.git' :
      request.command_key === 'git_branch_diff_shortstat' ? { additions: 1, deletions: 2, fileCount: 1, binaryFiles: 0, comparison: { kind: 'head', reference: 'HEAD', commit: 'a'.repeat(40) } } : '' })) }
  }
  test('ordinary summaries skip the unused remote command while preserving Git statistics', async () => {
    const api = fixture()
    const result = await loadProjectEnvironment(api, null, target, { includePullRequestUrl: false })
    expect(result).toMatchObject({ branchName: 'feature/details', additions: '+1', deletions: '-2' })
    expect(result.createPullRequestUrl).toBeUndefined()
    expect(api.executeCommand.mock.calls.map(([, value]) => value.command_key).sort())
      .toEqual(['git_branch', 'git_branch_diff_shortstat'])
  })
  test('a completed summary cannot replace a details read inside the existing short cache window', async () => {
    const api = fixture()
    await loadProjectEnvironment(api, null, target, { includePullRequestUrl: false })
    const result = await loadProjectEnvironment(api, null, target)
    expect(result.createPullRequestUrl).toBe('https://github.com/owned/details/compare/feature%2Fdetails?expand=1')
    expect(api.executeCommand.mock.calls.filter(([, value]) => value.command_key === 'git_branch')).toHaveLength(2)
    expect(api.executeCommand.mock.calls.filter(([, value]) => value.command_key === 'git_remote_url')).toHaveLength(1)
  })
  test('a pending summary cannot supply a concurrent details read', async () => {
    const api = fixture(), original = api.executeCommand.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let branches = 0
    api.executeCommand.mockImplementation(async (id, value) => {
      if (value.command_key === 'git_branch' && ++branches === 1) await gate
      return original(id, value)
    })
    const summary = loadProjectEnvironment(api, null, target, { includePullRequestUrl: false })
    const details = loadProjectEnvironment(api, null, target)
    try {
      await vi.waitFor(() => expect(branches).toBe(2))
      expect((await details).createPullRequestUrl).toContain('/compare/feature%2Fdetails')
    } finally { release(); await Promise.allSettled([summary, details]) }
  })
  test('a workspace write retires both summary and details projections', async () => {
    const api = fixture()
    for (let iteration = 0; iteration < 2; iteration++) {
      await loadProjectEnvironment(api, null, target, { includePullRequestUrl: false })
      await loadProjectEnvironment(api, null, target)
      if (iteration === 0) await checkoutProjectBranch(api, null, 'next', target)
    }
    expect(api.executeCommand.mock.calls.filter(([, value]) => value.command_key === 'git_branch')).toHaveLength(4)
    expect(api.executeCommand.mock.calls.filter(([, value]) => value.command_key === 'git_remote_url')).toHaveLength(2)
  })
})
