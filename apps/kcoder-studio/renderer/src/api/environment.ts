import type { DeviceCommandReadSource } from './devices'
import type { DeviceCommandRequest, DeviceCommandResponse, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { isAbortError } from '@/lib/async-errors'
import {
  configuredWorkspacePath,
  executionDeviceId,
  resolveProjectWorkspacePath,
} from '@/lib/project-workspace'

interface DeviceCommandApi extends DeviceCommandReadSource {
  executeCommand(deviceId: string, data: DeviceCommandRequest): Promise<DeviceCommandResponse>
}

type EnvironmentWorkspaceTarget = Pick<WorkspaceTarget, 'deviceId' | 'path'> &
  Partial<Pick<WorkspaceTarget, 'source'>>

interface GitRemoteParts {
  host: string
  repoPath: string
}

const EMPTY_ENVIRONMENT_INFO: EnvironmentInfo = {
  additions: '+0',
  deletions: '-0',
  executionTarget: 'local',
}
const INVALID_BRANCH_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\', ']'])
const ENVIRONMENT_INFO_CACHE_TTL_MS = 1500

export type EnvironmentDiffMode = 'branch' | 'unstaged' | 'staged' | 'commit'

export interface EnvironmentInfoLoadOptions {
  force?: boolean
  includePullRequestUrl?: boolean
}

const ENVIRONMENT_DIFF_COMMANDS: Record<EnvironmentDiffMode, string> = {
  branch: 'git_branch_diff',
  unstaged: 'git_diff_unstaged',
  staged: 'git_diff_staged',
  commit: 'git_diff_last_commit',
}
const GENERATED_COMMIT_MESSAGE_COMMAND = 'git_generate_commit_message'
const NO_CHANGES_TO_COMMIT_MESSAGE = 'No changes to commit'
const ENVIRONMENT_MUTATIONS = new Set([
  'git_add_all', 'git_commit_all', 'git_push', 'git_checkout', 'git_checkout_new', 'git_worktree_remove',
])

type EnvironmentReadScope = {
  deviceId?: string
  path?: string
  isCurrent: (targetId: string) => boolean
}

type EnvironmentInfoCacheEntry = {
  expiresAt: number
  promise: Promise<EnvironmentInfo>
  pending: boolean
  scope: EnvironmentReadScope
}

const environmentInfoCaches = new WeakMap<
  DeviceCommandApi,
  Map<string, EnvironmentInfoCacheEntry>
>()

function outputAsString(output: DeviceCommandResponse['stdout']): string {
  if (typeof output === 'string') {
    return output
  }
  if (Array.isArray(output) && output.every(item => typeof item === 'string')) {
    return output.join('\n')
  }
  throw new Error('Expected text stdout from device command')
}

function outputAsRecord(output: DeviceCommandResponse['stdout']): Record<string, unknown> | null {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return output && typeof output === 'object' && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null
}

function environmentInfoCacheKey(
  project: ProjectWithTasks | null,
  target: EnvironmentWorkspaceTarget | null | undefined,
  includePullRequestUrl: boolean
): string | null {
  const deviceId = target?.deviceId ?? (project ? executionDeviceId(project) : undefined)
  if (!deviceId) {
    return null
  }

  const config = project?.config
  const executionTarget = config?.execution?.targetType ?? 'local'
  // The requested fields partition unfinished and short-lived display results.
  return JSON.stringify([
    includePullRequestUrl,
    target ? { deviceId, path: target.path, executionTarget } : {
      projectId: project?.id ?? null,
      deviceId,
      executionTarget,
      workspaceSource: config?.workspace?.source,
      workspacePath: project ? configuredWorkspacePath(project) : null,
    },
  ])
}

function cloneEnvironmentInfo(info: EnvironmentInfo): EnvironmentInfo {
  return { ...info, ...(info.changeSummary ? { changeSummary: { ...info.changeSummary } } : {}) }
}

function getEnvironmentInfoCache(api: DeviceCommandApi): Map<string, EnvironmentInfoCacheEntry> {
  let cache = environmentInfoCaches.get(api)
  if (!cache) {
    cache = new Map<string, EnvironmentInfoCacheEntry>()
    environmentInfoCaches.set(api, cache)
  }
  return cache
}

function assertEnvironmentScope(scope: EnvironmentReadScope) {
  if (!scope.deviceId || !scope.isCurrent(scope.deviceId))
    throw new DOMException('Environment observation changed', 'AbortError')
}

function captureEnvironmentReadScope(
  api: DeviceCommandApi, project: ProjectWithTasks | null, target?: EnvironmentWorkspaceTarget | null
): EnvironmentReadScope {
  const accountCurrent = captureAccountContextRevision()
  const deviceId = (target?.deviceId ?? (project ? executionDeviceId(project) : undefined))?.trim()
  const sourceCurrent = api.captureReadSource?.(deviceId)
  return {
    deviceId,
    path: target?.path.trim(), isCurrent: targetId => accountCurrent(targetId) && sourceCurrent?.() !== false,
  }
}

function environmentReadApi(api: DeviceCommandApi, scope: EnvironmentReadScope): DeviceCommandApi {
  return {
    async executeCommand(deviceId, data) {
      try {
        if (deviceId !== scope.deviceId) throw new DOMException('Environment target changed', 'AbortError')
        if (!scope.path && data.path) scope.path = data.path
        assertEnvironmentScope(scope)
        const response = await api.executeCommand(deviceId, data)
        assertEnvironmentScope(scope)
        return response
      } catch (error) {
        if (isAbortError(error)) scope.isCurrent = () => false
        assertEnvironmentScope(scope)
        throw error
      }
    },
  }
}

async function readWorkspaceEnvironment<T>(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target: EnvironmentWorkspaceTarget | null | undefined,
  read: (api: DeviceCommandApi, context: { deviceId: string; path: string }) => Promise<T>
): Promise<T> {
  const scope = captureEnvironmentReadScope(api, project, target)
  const scopedApi = environmentReadApi(api, scope)
  const context = await commandContext(scopedApi, project, target)
  try { return await read(scopedApi, context) }
  finally { assertEnvironmentScope(scope) }
}

/** A write retires all display variants of its workspace, including pending readers. */
function invalidateEnvironmentInfo(api: DeviceCommandApi, deviceId: string, path: string) {
  const cache = environmentInfoCaches.get(api)
  if (!cache) return
  for (const [key, entry] of cache) {
    if (entry.scope.deviceId !== deviceId || entry.scope.path && entry.scope.path !== path) continue
    entry.scope.isCurrent = () => false
    cache.delete(key)
  }
}

async function resolveProjectWorkspaceRoot(
  api: DeviceCommandApi,
  deviceId: string
): Promise<string> {
  const response = await api.executeCommand(deviceId, {
    command_key: 'project_workspace_root',
    timeout_seconds: 10,
    max_output_bytes: 4096,
  })
  if (!response.success) {
    throw new Error(response.error || response.stderr || 'Failed to resolve project workspace root')
  }
  const root = outputAsString(response.stdout).trim()
  if (!root) {
    throw new Error('Project workspace root is empty')
  }
  return root
}

async function workspacePath(
  api: DeviceCommandApi,
  deviceId: string,
  project: ProjectWithTasks
): Promise<string | undefined> {
  return resolveProjectWorkspacePath(project, deviceId, {
    getProjectWorkspaceRoot: targetDeviceId => resolveProjectWorkspaceRoot(api, targetDeviceId),
  })
}

function validateBranchName(branchName: string): void {
  const components = branchName.split('/')
  const invalidComponent = components.some(
    component => !component || component.startsWith('.') || component.endsWith('.lock')
  )
  const invalidCharacter = Array.from(branchName).some(character => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 || INVALID_BRANCH_CHARACTERS.has(character)
  })

  if (
    branchName === '@' ||
    branchName.startsWith('-') ||
    branchName.endsWith('.') ||
    branchName.includes('..') ||
    branchName.includes('@{') ||
    branchName.includes('//') ||
    invalidCharacter ||
    invalidComponent
  ) {
    throw new Error('Invalid branch name')
  }
}

export function parseGitShortStat(value: string): Pick<EnvironmentInfo, 'additions' | 'deletions'> {
  // A legacy pending-file count cannot be presented as a line count.
  if (/\d+\s+file\(s\)\s+pending/.test(value)) {
    return { additions: '', deletions: '' }
  }

  const additionsMatch = value.match(/(\d+)\s+insertions?\(\+\)/)
  const deletionsMatch = value.match(/(\d+)\s+deletions?\(-\)/)
  if (value.trim() && !additionsMatch && !deletionsMatch && !/\d+\s+files? changed/.test(value)) {
    return { additions: '', deletions: '' }
  }

  return {
    additions: `+${additionsMatch?.[1] ?? '0'}`,
    deletions: `-${deletionsMatch?.[1] ?? '0'}`,
  }
}

function parseGitRemote(remoteUrl: string): GitRemoteParts | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '')
  if (!trimmed) {
    return null
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/)
  if (sshMatch) {
    return {
      host: sshMatch[1],
      repoPath: sshMatch[2],
    }
  }

  try {
    const url = new URL(trimmed)
    return {
      host: url.host,
      repoPath: url.pathname.replace(/^\/+/, ''),
    }
  } catch {
    return null
  }
}

export function buildPullRequestUrl(remoteUrl: string, branchName: string): string | undefined {
  const remote = parseGitRemote(remoteUrl)
  const branch = branchName.trim()
  if (!remote || !branch) {
    return undefined
  }

  const encodedBranch = encodeURIComponent(branch)
  if (remote.host.includes('github')) {
    return `https://${remote.host}/${remote.repoPath}/compare/${encodedBranch}?expand=1`
  }

  if (remote.host.includes('gitlab')) {
    const params = new URLSearchParams()
    params.set('merge_request[source_branch]', branch)
    return `https://${remote.host}/${remote.repoPath}/-/merge_requests/new?${params.toString()}`
  }

  return undefined
}

export async function workspaceHasUncommittedChanges(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<boolean> {
  return readWorkspaceEnvironment(api, null, { deviceId, path }, async (reader, context) => {
    const porcelain = await runGitCommand(reader, context.deviceId, 'git_status_porcelain', context.path, {
      maxOutputBytes: 64 * 1024,
    })
    return porcelain.length > 0
  })
}

export async function removeGitWorktree(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<void> {
  await runGitCommand(api, deviceId, 'git_worktree_remove', path, {
    args: [path, path],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

function prioritizeBranches(
  branches: string[],
  preferredBranches: Array<string | null | undefined>
): string[] {
  const preferred = preferredBranches
    .map(branch => branch?.trim())
    .filter((branch): branch is string => Boolean(branch))

  const uniqueBranches = [...new Set(branches)].filter(Boolean)
  const preferredSet = new Set(preferred)
  const orderedPreferred = preferred.filter(branch => uniqueBranches.includes(branch))
  const remaining = uniqueBranches.filter(branch => !preferredSet.has(branch))
  return [...orderedPreferred, ...remaining]
}

async function runGitCommand(
  api: DeviceCommandApi,
  deviceId: string,
  commandKey: string,
  path: string,
  options: {
    args?: string[]
    timeoutSeconds?: number
    maxOutputBytes?: number
  } = {}
): Promise<string> {
  const request: DeviceCommandRequest = {
    command_key: commandKey,
    path,
    timeout_seconds: options.timeoutSeconds ?? 10,
    max_output_bytes: options.maxOutputBytes ?? 4096,
  }
  if (options.args) {
    request.args = options.args
  }

  const mutationCurrent = ENVIRONMENT_MUTATIONS.has(commandKey)
    ? captureEnvironmentReadScope(api, null, { deviceId, path }).isCurrent
    : null
  if (mutationCurrent) invalidateEnvironmentInfo(api, deviceId, path)
  try {
    const response = await api.executeCommand(deviceId, request)
    if (!response.success) {
      const stdout = outputAsString(response.stdout).trim()
      throw new Error(
        [response.error, response.stderr, stdout].filter(Boolean).join('\n') || `${commandKey} failed`
      )
    }
    return outputAsString(response.stdout).trim()
  } finally {
    if (mutationCurrent?.(deviceId)) invalidateEnvironmentInfo(api, deviceId, path)
  }
}

async function probeGitRepository(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<boolean> {
  const response = await api.executeCommand(deviceId, {
    command_key: 'git_is_worktree',
    path,
    args: [path],
    timeout_seconds: 10,
    max_output_bytes: 4096,
  })

  return response.success && outputAsString(response.stdout).trim() === 'true'
}

async function generateCommitMessage(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<string> {
  const response = await api.executeCommand(deviceId, {
    command_key: GENERATED_COMMIT_MESSAGE_COMMAND,
    path,
    timeout_seconds: 120,
    max_output_bytes: 8192,
  })

  if (!response.success) {
    throw new Error(response.error || response.stderr || 'Failed to generate commit message')
  }

  const payload = outputAsRecord(response.stdout)
  if (!payload) {
    throw new Error('Failed to generate commit message')
  }
  if (payload.success === false) {
    const error = typeof payload.error === 'string' ? payload.error.trim() : ''
    throw new Error(error || 'Failed to generate commit message')
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  const firstLine = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
  if (!firstLine) {
    throw new Error('Failed to generate commit message')
  }
  return firstLine
}

async function loadBranchDiffShortStat(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<Pick<EnvironmentInfo, 'additions' | 'deletions' | 'changeSummary' | 'error'>> {
  try {
    const response = await api.executeCommand(deviceId, {
      command_key: 'git_branch_diff_shortstat',
      path,
      args: ['--json'],
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    if (!response.success || response.timed_out || response.stdout_truncated) {
      throw new Error(response.error || response.stderr || 'Failed to load change statistics')
    }
    const summary = outputAsRecord(response.stdout)
    if (!summary) {
      return parseGitShortStat(outputAsString(response.stdout))
    }
    const comparison = summary.comparison as Record<string, unknown> | undefined
    const validCount = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    if (
      !validCount(summary.additions) ||
      !validCount(summary.deletions) ||
      !validCount(summary.fileCount) ||
      !validCount(summary.binaryFiles) ||
      !comparison ||
      !['merge-base', 'head', 'empty'].includes(String(comparison.kind)) ||
      (comparison.kind === 'empty'
        ? comparison.reference !== null || comparison.commit !== null
        : typeof comparison.reference !== 'string' ||
          !comparison.reference.trim() ||
          typeof comparison.commit !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(comparison.commit))
    ) {
      throw new Error('Invalid Git change summary')
    }
    return {
      additions: `+${summary.additions}`,
      deletions: `-${summary.deletions}`,
      changeSummary: {
        kind: comparison.kind as NonNullable<EnvironmentInfo['changeSummary']>['kind'],
        reference: comparison.reference as string | null,
        commit: comparison.commit as string | null,
        fileCount: summary.fileCount,
        binaryFiles: summary.binaryFiles,
      },
    }
  } catch (error) {
    return {
      additions: '',
      deletions: '',
      error: error instanceof Error ? error.message : 'Failed to load change statistics',
    }
  }
}

async function commandContext(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): Promise<{ deviceId: string; path: string }> {
  if (target) {
    const deviceId = target.deviceId.trim()
    const path = target.path.trim()
    if (!deviceId || !path) {
      throw new Error('Workspace target device and path are required')
    }
    return { deviceId, path }
  }

  if (!project) {
    throw new Error('Project is required')
  }

  const deviceId = executionDeviceId(project)

  if (!deviceId) {
    throw new Error('Project device and workspace path are required')
  }

  const path = await workspacePath(api, deviceId, project)
  if (!path) {
    throw new Error('Project device and workspace path are required')
  }
  return { deviceId, path }
}

async function loadProjectEnvironmentUncached(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target: EnvironmentWorkspaceTarget | null | undefined,
  includePullRequestUrl: boolean
): Promise<EnvironmentInfo> {
  if (!project && !target) {
    return EMPTY_ENVIRONMENT_INFO
  }

  const executionTarget = project?.config?.execution?.targetType ?? 'local'
  const initialDeviceId = target?.deviceId ?? (project ? executionDeviceId(project) : undefined)
  const baseInfo: EnvironmentInfo = {
    ...EMPTY_ENVIRONMENT_INFO,
    executionTarget,
    deviceId: initialDeviceId,
  }

  if (!initialDeviceId) {
    return baseInfo
  }

  let deviceId: string
  let path: string
  try {
    const context = await commandContext(api, project, target)
    deviceId = context.deviceId
    path = context.path
  } catch (error) {
    return {
      ...baseInfo,
      error: error instanceof Error ? error.message : 'Failed to load environment info',
    }
  }

  const environmentWorkspaceInfo = {
    ...baseInfo,
    deviceId,
    workspacePath: path,
  }

  try {
    const branch = runGitCommand(api, deviceId, 'git_branch', path)
    const remote = includePullRequestUrl
      ? branch.then(() => runGitCommand(api, deviceId, 'git_remote_url', path)).catch(() => '')
      : Promise.resolve('')
    const [branchName, diff] = await Promise.all([
      branch,
      loadBranchDiffShortStat(api, deviceId, path),
    ])
    // Older backends ignore --json and only describe tracked files. Keep their
    // untracked-file count separate; it must never be added to line totals.
    const [porcelain, remoteUrl] = await Promise.all([
      diff.changeSummary ? '' : runGitCommand(api, deviceId, 'git_status_porcelain', path).catch(() => ''),
      remote,
    ])
    const untrackedCount = porcelain.split('\n').filter(line => line.startsWith('??')).length

    return {
      ...environmentWorkspaceInfo,
      ...diff,
      ...(untrackedCount > 0 ? { untrackedFileCount: untrackedCount } : {}),
      isGitRepository: true,
      branchName,
      createPullRequestUrl: buildPullRequestUrl(remoteUrl, branchName),
    }
  } catch (error) {
    const isGitRepository = await probeGitRepository(api, deviceId, path).catch(() => undefined)
    if (isGitRepository === false) {
      return {
        ...environmentWorkspaceInfo,
        isGitRepository: false,
      }
    }

    return {
      ...environmentWorkspaceInfo,
      additions: '',
      deletions: '',
      error: error instanceof Error ? error.message : 'Failed to load environment info',
    }
  }
}

export async function loadProjectEnvironment(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null,
  options: EnvironmentInfoLoadOptions = {}
): Promise<EnvironmentInfo> {
  if (!project && !target) {
    return cloneEnvironmentInfo(EMPTY_ENVIRONMENT_INFO)
  }

  const includePullRequestUrl = options.includePullRequestUrl !== false
  const cacheKey = environmentInfoCacheKey(project, target, includePullRequestUrl)
  // A project without a device returns display metadata without executing commands.
  if (!cacheKey) return loadProjectEnvironmentUncached(api, project, target, includePullRequestUrl)
  const now = Date.now()
  const cache = getEnvironmentInfoCache(api)
  const cached = cache.get(cacheKey)
  const scopeCurrent = cached && cached.scope.deviceId && cached.scope.isCurrent(cached.scope.deviceId)
  if (!options.force && cached && scopeCurrent && (cached.pending || cached.expiresAt > now)) {
    const result = await cached.promise
    assertEnvironmentScope(cached.scope)
    return cloneEnvironmentInfo(result)
  }

  // Forced reads share the owner, never the query. A write must also retire an
  // older pending read after a newer forced read has replaced its cache entry.
  const scope = scopeCurrent ? cached.scope : captureEnvironmentReadScope(api, project, target)
  const promise = loadProjectEnvironmentUncached(environmentReadApi(api, scope), project, target, includePullRequestUrl)
  const entry = { expiresAt: now + ENVIRONMENT_INFO_CACHE_TTL_MS, promise, pending: true, scope }
  cache.set(cacheKey, entry)
  try {
    const result = await promise
    assertEnvironmentScope(scope)
    return cloneEnvironmentInfo(result)
  } catch (error) {
    if (cache.get(cacheKey) === entry) cache.delete(cacheKey)
    throw error
  } finally {
    entry.pending = false
  }
}

export async function loadProjectEnvironmentDiff(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null,
  mode: EnvironmentDiffMode = 'branch'
): Promise<string> {
  return readWorkspaceEnvironment(api, project, target, (reader, { deviceId, path }) =>
    runGitCommand(reader, deviceId, ENVIRONMENT_DIFF_COMMANDS[mode], path, {
      timeoutSeconds: 30,
      maxOutputBytes: 5 * 1024 * 1024,
    }))
}

export async function commitProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  message: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  let commitMessage = message.trim()

  const { deviceId, path } = await commandContext(api, project, target)

  if (!commitMessage) {
    await runGitCommand(api, deviceId, 'git_add_all', path, {
      timeoutSeconds: 30,
      maxOutputBytes: 4096,
    })
    const stagedDiff = await runGitCommand(api, deviceId, 'git_diff_staged', path, {
      timeoutSeconds: 30,
      maxOutputBytes: 4096,
    })
    if (!stagedDiff.trim()) {
      throw new Error(NO_CHANGES_TO_COMMIT_MESSAGE)
    }
    commitMessage = await generateCommitMessage(api, deviceId, path)
  }

  await runGitCommand(api, deviceId, 'git_commit_all', path, {
    args: ['-m', commitMessage],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
  const remainingChanges = await runGitCommand(api, deviceId, 'git_status_porcelain', path, {
    timeoutSeconds: 15,
    maxOutputBytes: 64 * 1024,
  })
  if (remainingChanges.trim()) {
    throw new Error('Git commit returned without committing all workspace changes')
  }
}

export async function pushProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  const { deviceId, path } = await commandContext(api, project, target)
  await runGitCommand(api, deviceId, 'git_push', path, {
    timeoutSeconds: 120,
    maxOutputBytes: 8192,
  })
}

export async function commitAndPushProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  message: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  await commitProjectChanges(api, project, message, target)
  await pushProjectChanges(api, project, target)
}

export async function listProjectBranches(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): Promise<string[]> {
  return readWorkspaceEnvironment(api, project, target, async (reader, { deviceId, path }) => {
    const [output, currentBranch] = await Promise.all([
      runGitCommand(reader, deviceId, 'git_branch_list', path, {
        timeoutSeconds: 15,
        maxOutputBytes: 1024 * 64,
      }),
      runGitCommand(reader, deviceId, 'git_branch', path).catch(() => ''),
    ])

    const branches = output
      .split('\n')
      .map(branch => branch.trim())
      .filter(Boolean)
    return prioritizeBranches(branches, [currentBranch])
  })
}

export async function checkoutProjectBranch(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  branchName: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  const { deviceId, path } = await commandContext(api, project, target)
  await runGitCommand(api, deviceId, 'git_checkout', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

export async function createAndCheckoutProjectBranch(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  branchName: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  const { deviceId, path } = await commandContext(api, project, target)
  await runGitCommand(api, deviceId, 'git_checkout_new', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}
