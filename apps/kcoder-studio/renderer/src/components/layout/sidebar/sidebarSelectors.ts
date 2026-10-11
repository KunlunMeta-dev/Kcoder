import { useTranslation } from '@/hooks/useTranslation'

import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectWork,
  RuntimeTaskAddress,
} from '@/types/api'

import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'
import type { KeyboardEvent } from 'react'

import { canUseForProjectCreation, isClaudeCodeDevice } from '@/lib/device-capabilities'
import { standaloneRuntimeProjectKey } from '@/lib/runtime-project'
import type { RuntimeWorkListResponse, User as UserProfile } from '@/types/api'
import { type ProjectHoverSource } from '../ProjectSidebarHoverCardContent'

export const PROJECT_APPEARANCE_COLORS = [
  'blue',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
  'black',
] as const

export const PROJECT_APPEARANCE_COLOR_VALUES: Record<string, string> = {
  black: '#4b5563',
  blue: '#3b82f6',
  green: '#22c55e',
  orange: '#f97316',
  pink: '#ec4899',
  purple: '#a855f7',
  red: '#ef4444',
  yellow: '#eab308',
}

export function getSidebarAccountSummary(user: UserProfile | null, fallback: string) {
  const userName = user?.user_name?.trim()
  const email = user?.email?.trim()
  const label = userName || email || fallback
  const detail = email && email !== label ? email : fallback
  return {
    label,
    detail,
  }
}

export function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name || device.device_id
}

export function normalizeSidebarWorkspacePath(path: string): string {
  const trimmedPath = path.trim()
  if (trimmedPath === '/') return trimmedPath
  return trimmedPath.replace(/\/+$/, '')
}

export function getSidebarPathBasename(path: string): string {
  const normalizedPath = normalizeSidebarWorkspacePath(path)
  const parts = normalizedPath.split('/').filter(Boolean)
  return parts.at(-1) ?? normalizedPath
}

export function runtimeWorkHasWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  deviceId: string,
  workspacePath: string
): boolean {
  const normalizedPath = normalizeSidebarWorkspacePath(workspacePath)
  return (runtimeWork?.projects ?? []).some(projectWork =>
    projectWork.deviceWorkspaces.some(
      workspace =>
        workspace.deviceId === deviceId &&
        normalizeSidebarWorkspacePath(workspace.workspacePath) === normalizedPath
    )
  )
}

export function standaloneRuntimeProjectWork(
  devices: DeviceInfo[],
  deviceId: string | null | undefined,
  workspacePath: string | null | undefined,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): RuntimeProjectWork | null {
  const normalizedDeviceId = deviceId?.trim()
  const normalizedWorkspacePath = workspacePath ? normalizeSidebarWorkspacePath(workspacePath) : ''
  if (!normalizedDeviceId || !normalizedWorkspacePath) return null
  if (runtimeWorkHasWorkspace(runtimeWork, normalizedDeviceId, normalizedWorkspacePath)) {
    return null
  }

  const deviceState = getSidebarDeviceState(normalizedDeviceId, devices)
  const device = deviceState?.device
  const resolvedDeviceId = deviceState?.deviceId ?? normalizedDeviceId
  const deviceStatus = deviceState?.status ?? 'unavailable'
  return {
    project: {
      key: standaloneRuntimeProjectKey(normalizedWorkspacePath),
      stateDeviceId: resolvedDeviceId,
      name: getSidebarPathBasename(normalizedWorkspacePath),
      description: normalizedWorkspacePath,
      color: null,
    },
    deviceWorkspaces: [
      {
        id: null,
        projectId: null,
        deviceId: resolvedDeviceId,
        deviceName: device ? getStandaloneDeviceLabel(device) : resolvedDeviceId,
        deviceStatus,
        available: deviceStatus === 'online' || deviceStatus === 'busy',
        workspacePath: normalizedWorkspacePath,
        workspaceKind: 'workspace',
        worktreeId: null,
        mapped: true,
        tasks: [],
      },
    ],
  }
}

export type SidebarDeviceStatus = DeviceInfo['status'] | 'unavailable'

export interface SidebarDeviceState {
  deviceId: string
  device?: DeviceInfo
  status: SidebarDeviceStatus
}

export function getProjectDeviceId(project: ProjectWithTasks): string | undefined {
  return project.config?.execution?.deviceId ?? project.config?.device_id
}

export function getSidebarDeviceState(
  deviceId: string | null | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  if (!deviceId) return null

  const device =
    devices.find(item => item.device_id === deviceId) ??
    (deviceId === 'local-device'
      ? (devices.find(item => item.device_type === 'local' && item.status === 'online') ??
        devices.find(item => item.device_type === 'local') ??
        null)
      : null)
  return {
    deviceId: device?.device_id ?? deviceId,
    device: device ?? undefined,
    status: device?.status ?? 'unavailable',
  }
}

export function isSidebarDeviceOnline(deviceState: SidebarDeviceState | null): boolean {
  return !deviceState || deviceState.status === 'online'
}

export function getSidebarDeviceName(deviceState: SidebarDeviceState): string {
  return deviceState.device?.name || deviceState.deviceId
}

export function getDeviceNetworkLabel(device?: DeviceInfo): string | null {
  const runtimeTransferHost = getDisplayableNetworkHost(device?.runtime_transfer_host)
  if (runtimeTransferHost) return runtimeTransferHost
  return getDisplayableNetworkHost(device?.client_ip)
}

export function hasCloudRuntimeRoute(device?: DeviceInfo): boolean {
  return Boolean(
    device?.runtime_routes?.some(
      route => route.kind === 'cloud-relay' || route.kind === 'remote-relay'
    )
  )
}

export function getDeviceRouteLabel(deviceState: SidebarDeviceState): string {
  return getDeviceNetworkLabel(deviceState.device) || deviceState.deviceId
}

export function getDeviceRouteTitle(deviceState: SidebarDeviceState): string {
  const routes = deviceState.device?.runtime_routes
  if (!routes?.length) return getDeviceRouteLabel(deviceState)
  return routes.map(route => `${route.kind}: ${route.device_id}`).join('\n')
}

export function getDisplayableNetworkHost(value?: string | null): string | null {
  if (!value) return null
  return extractNetworkHost(value.trim()) || null
}

export function extractNetworkHost(value: string): string {
  const bracketMatch = value.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]
  const colonParts = value.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }
  return value
}

export function getRuntimeProjectDeviceState(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  const workspace = workspaces.find(candidate => candidate.available !== false) ?? workspaces[0]
  if (!workspace) return null
  const resolvedDevice = getSidebarDeviceState(workspace.deviceId, devices)
  if (
    workspace.workspaceSource !== 'remote' &&
    !workspaces.some(candidate => candidate.available !== false)
  ) {
    return {
      deviceId: resolvedDevice?.deviceId ?? workspace.deviceName ?? workspace.deviceId,
      device: resolvedDevice?.device,
      status: 'unavailable',
    }
  }
  if (resolvedDevice?.device) return resolvedDevice
  return {
    deviceId: workspace.deviceName || workspace.remoteHostId || workspace.deviceId,
    status: (workspace.deviceStatus ??
      resolvedDevice?.status ??
      'unavailable') as SidebarDeviceStatus,
  }
}

export function isRuntimeRemoteProject(
  runtimeProjectWork: RuntimeProjectWork | undefined
): boolean {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  return (
    workspaces.length > 0 && workspaces.every(workspace => workspace.workspaceSource === 'remote')
  )
}

export function shortenSidebarHomePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/u, '~')
}

export function getSidebarRepositoryLabel(repoUrl?: string | null): string | null {
  const value = repoUrl?.trim()
  if (!value) return null
  const normalized = value.replace(/\.git$/u, '').replace(/\/+$/u, '')
  const sshMatch = normalized.match(/^[^@]+@[^:]+:(.+)$/u)
  const path = sshMatch?.[1] ?? normalized.replace(/^[a-z]+:\/\/[^/]+\//iu, '')
  const parts = path.split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : parts[0] || value
}

export function getRuntimeTaskRepositoryLabel(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): string | null {
  const taskRepoUrl = getRuntimeTaskGitInfoValue(task, [
    'originUrl',
    'origin_url',
    'repoUrl',
    'repo_url',
  ])
  return getSidebarRepositoryLabel(
    workspace.repoUrl || (typeof taskRepoUrl === 'string' ? taskRepoUrl : null)
  )
}

export function getRuntimeTaskGitInfoValue(task: RuntimeTaskSummary, keys: string[]): unknown {
  if (!task.gitInfo || typeof task.gitInfo !== 'object') return undefined
  return keys.map(key => task.gitInfo?.[key]).find(value => value !== undefined && value !== null)
}

export function getRuntimeTaskBranch(task: RuntimeTaskSummary): string | null {
  const branch = getRuntimeTaskGitInfoValue(task, ['branch', 'branchName', 'branch_name'])
  return typeof branch === 'string' && branch.trim() ? branch.trim() : null
}

export function hasRuntimeTaskBranchWarning(task: RuntimeTaskSummary): boolean {
  const taskBranch = getRuntimeTaskBranch(task)
  const currentBranch = getRuntimeTaskGitInfoValue(task, ['currentBranch', 'current_branch'])
  if (taskBranch && typeof currentBranch === 'string' && currentBranch.trim()) {
    return taskBranch !== currentBranch.trim()
  }
  return (
    getRuntimeTaskGitInfoValue(task, [
      'branchMismatch',
      'branch_mismatch',
      'isBranchOutdated',
      'is_branch_outdated',
    ]) === true
  )
}

export function isRuntimeTaskWaiting(task: RuntimeTaskSummary): boolean {
  const status = task.status?.trim().toLowerCase() ?? ''
  return ['waiting', 'approval', 'input', 'attention', 'blocked'].some(value =>
    status.includes(value)
  )
}

export function getProjectHoverSources(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  finderWorkspacePath: string | null,
  openFinder: (path: string) => void,
  openFinderLabel: (path: string) => string
): ProjectHoverSource[] {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  const sources: ProjectHoverSource[] = []
  const seen = new Set<string>()
  const add = (source: ProjectHoverSource) => {
    const key = `${source.kind}\0${source.value}`
    if (!source.value || seen.has(key)) return
    seen.add(key)
    sources.push(source)
  }

  for (const workspace of workspaces) {
    if (workspace.workspaceSource === 'remote' || workspace.remoteHostId) {
      const host = workspace.remoteHostId || workspace.deviceName || workspace.deviceId
      add({ id: `host:${host}`, kind: 'host', value: host })
    }
  }

  const roots = runtimeProjectWork?.project.roots?.length
    ? runtimeProjectWork.project.roots.map(root => root.path)
    : workspaces.length > 0
      ? workspaces.map(workspace => workspace.workspacePath)
      : finderWorkspacePath
        ? [finderWorkspacePath]
        : []
  for (const path of roots) {
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    const canOpen = finderWorkspacePath === normalizedPath
    add({
      id: `path:${normalizedPath}`,
      kind: 'path',
      value: shortenSidebarHomePath(normalizedPath),
      actionLabel: canOpen ? openFinderLabel(normalizedPath) : undefined,
      onOpen: canOpen ? () => openFinder(normalizedPath) : undefined,
    })
  }
  return sources
}

export function isLocalProjectFinderDevice(device: DeviceInfo | undefined): device is DeviceInfo {
  if (!device) return false

  return (
    !isCloudDevice(device) &&
    !isRemoteDevice(device) &&
    isClaudeCodeDevice(device) &&
    canUseForProjectCreation(device)
  )
}

export function getProjectFinderWorkspacePath(
  project: ProjectWithTasks,
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[]
): string | null {
  const runtimeWorkspace = runtimeProjectWork?.deviceWorkspaces.find(workspace => {
    const workspacePath = workspace.workspacePath.trim()
    const device = devices.find(item => item.device_id === workspace.deviceId)
    return Boolean(workspacePath) && isLocalProjectFinderDevice(device)
  })
  if (runtimeWorkspace) return runtimeWorkspace.workspacePath.trim()

  const projectWorkspacePath = project.config?.workspace?.localPath?.trim()
  const projectDevice = devices.find(item => item.device_id === getProjectDeviceId(project))
  if (projectWorkspacePath && isLocalProjectFinderDevice(projectDevice)) {
    return projectWorkspacePath
  }

  return null
}

export function shouldShowProjectDeviceStatus(
  deviceState: SidebarDeviceState | null,
  devices: DeviceInfo[],
  remoteProject: boolean
): deviceState is SidebarDeviceState {
  if (!deviceState) return false
  if (deviceState.status === 'unavailable') return true
  if (remoteProject) return true
  if (hasCloudRuntimeRoute(deviceState.device) && deviceState.device?.device_type !== 'local') {
    return true
  }
  if (devices.length <= 1) return false
  return Boolean(
    deviceState.device && (isCloudDevice(deviceState.device) || isRemoteDevice(deviceState.device))
  )
}

export function getRuntimeWorkspaceDeviceColor(workspace: RuntimeDeviceWorkspace): string {
  return getSidebarDeviceColor(getSidebarDeviceColorKey(workspace.deviceName, workspace.deviceId))
}

export function getSidebarDeviceStatusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: SidebarDeviceStatus
) {
  if (status === 'online') {
    return t('workbench.project_device_status_online', '在线')
  }
  if (status === 'busy') {
    return t('workbench.project_device_status_busy', '忙碌')
  }
  if (status === 'offline') {
    return t('workbench.project_device_status_offline', '离线')
  }
  return t('workbench.project_device_status_unavailable', '不可用')
}

export function getRuntimeNotificationKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}\0${address.workspacePath ?? ''}`
}

export function getRuntimeTaskThreadId(task: RuntimeTaskSummary): string | null {
  const explicitThreadId = task.threadId?.trim()
  if (explicitThreadId) return explicitThreadId

  const runtimeHandleThreadId = [task.runtimeHandle?.threadId, task.runtimeHandle?.thread_id].find(
    value => typeof value === 'string' && value.trim()
  )
  if (typeof runtimeHandleThreadId === 'string') return runtimeHandleThreadId.trim()

  const taskId = task.taskId.trim()
  return (task.runtime === 'kcoder' || task.runtime === 'codex') && !task.optimistic && taskId
    ? taskId
    : null
}

export function isRuntimeTaskNotificationSubscribed(
  settings: RuntimeIMNotificationSettingsResponse | null | undefined,
  address: RuntimeTaskAddress
): boolean {
  const key = getRuntimeNotificationKey(address)
  return Boolean(
    settings?.runtimeTaskSubscriptions?.some(
      subscription => getRuntimeNotificationKey(subscription.address) === key
    )
  )
}

export function getDeviceUnavailableActionTitle(
  t: ReturnType<typeof useTranslation>['t'],
  deviceState: SidebarDeviceState
) {
  const status = getSidebarDeviceStatusLabel(t, deviceState.status)
  return formatSidebarTemplate(
    t('workbench.project_chat_device_unavailable', '设备{{status}}，无法新建项目对话：{{device}}'),
    { status, device: getSidebarDeviceName(deviceState) }
  )
}

export function getImNotificationSessionLabel(
  settings: RuntimeIMNotificationSettingsResponse | null | undefined
): string | null {
  const session = settings?.global.session
  if (!session) return null
  const displayName = session.displayName || session.senderId
  return `${session.channelLabel} / ${displayName}`
}

export function getGlobalImNotificationTitle(
  t: ReturnType<typeof useTranslation>['t'],
  settings: RuntimeIMNotificationSettingsResponse | null | undefined,
  cloudStatus?: 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error'
): string {
  if (cloudStatus === 'disconnected') {
    return t(
      'workbench.global_im_notifications_requires_cloud_login',
      '登录云端后可开启离开电脑提醒'
    )
  }
  if (cloudStatus === 'expired' || cloudStatus === 'error') {
    return t(
      'workbench.global_im_notifications_requires_cloud_login',
      '登录云端后可开启离开电脑提醒'
    )
  }
  if (cloudStatus === 'connecting') {
    return t('workbench.cloud_connection_connecting', '正在连接云端')
  }

  const target = getImNotificationSessionLabel(settings)
  if (settings?.global.enabled) {
    return target
      ? `${t('workbench.away_im_reminder_on', '离开电脑提醒已开启')} · ${target}`
      : t('workbench.away_im_reminder_on', '离开电脑提醒已开启')
  }
  if (!target) {
    return t('workbench.away_im_reminder_needs_session', '需要选择 IM 会话')
  }
  return target
    ? `${t('workbench.away_im_reminder_enable', '开启离开电脑提醒')} · ${target}`
    : t('workbench.away_im_reminder_enable', '开启离开电脑提醒')
}

export function formatSidebarTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template
  )
}

export function canEditLocalRuntimeProject(
  projectWork: RuntimeProjectWork | undefined,
  sidebarStateDeviceId: string | null | undefined
): boolean {
  if (!projectWork || projectWork.project.source === 'remote_project') return false
  const stateDeviceId = projectWork.project.stateDeviceId?.trim()
  const hasRoutableDevice = Boolean(
    stateDeviceId || projectWork.deviceWorkspaces.some(workspace => workspace.deviceId.trim())
  )
  return Boolean(
    hasRoutableDevice &&
    (projectWork.project.source === 'local_project' || stateDeviceId === sidebarStateDeviceId)
  )
}

export function calculateSidebarUpdateDownloadPercent(
  downloadedBytes: number,
  totalBytes: number | null
): number | null {
  if (!totalBytes || totalBytes <= 0) return null
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
}

export const MACOS_WINDOW_CONTROLS_SAFE_AREA_CLASS = 'left-[92px]'

export const SIDEBAR_ROW_METADATA_CLASS =
  'flex items-center gap-1 text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover/task:invisible'

export const SIDEBAR_DEVICE_COLORS = [
  '#5B7CFA',
  '#3FA67A',
  '#C9892B',
  '#8F6DD8',
  '#C65D5D',
  '#339DA0',
  '#B35EA4',
  '#6F9B4B',
] as const

export function getSidebarDeviceColorKey(
  deviceName: string | null | undefined,
  deviceId: string | null | undefined
): string {
  return deviceName?.trim() || deviceId?.trim() || 'device'
}

export function getSidebarDeviceColor(colorKey: string): string {
  let hash = 0

  for (let index = 0; index < colorKey.length; index += 1) {
    hash = (hash * 31 + colorKey.charCodeAt(index)) >>> 0
  }

  return SIDEBAR_DEVICE_COLORS[hash % SIDEBAR_DEVICE_COLORS.length]
}

export function handleSidebarRowKeyDown(event: KeyboardEvent<HTMLDivElement>, onOpen: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return

  event.preventDefault()
  onOpen()
}

export const RUNTIME_ARCHIVE_UNDO_DELAY_MS = 3000
