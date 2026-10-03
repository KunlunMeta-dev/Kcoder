import type { RemoteTerminalClient } from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
import { type GatewayServer } from '../../gatewayRpc'
import { record, sanitizeBrowserLabelSegment, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function serverForBrowserLabel(
  this: GatewayRuntimeCore,
  label: string
): Promise<GatewayServer> {
  const matchingTasks = Array.from(this.tasks.values()).filter(
    task => `workspace-browser-${sanitizeBrowserLabelSegment(task.taskId)}` === label
  )
  const serverIds = [...new Set(matchingTasks.map(task => task.serverId))]
  if (serverIds.length > 1) {
    throw new Error(`浏览器标签对应多个 KCoder 服务器：${label}`)
  }
  if (serverIds.length === 1) {
    const server = (await this.servers()).find(candidate => candidate.id === serverIds[0])
    if (!server) throw new Error(`浏览器任务服务器已不存在：${serverIds[0]}`)
    return server
  }
  return this.server()
}

export async function openBrowser(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.browserRuntime.openBrowser(rawParams)
}

export async function setBrowserBounds(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.browserRuntime.setBrowserBounds(rawParams)
}

export async function controlBrowser(
  this: GatewayRuntimeCore,
  labelValue: unknown,
  action: Record<string, unknown>
) {
  return this.browserRuntime.controlBrowser(labelValue, action)
}

export async function evaluateBrowser(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.browserRuntime.evaluateBrowser(rawParams)
}

export function readBrowserPageState(this: GatewayRuntimeCore, labelValue: unknown) {
  return this.browserRuntime.readBrowserPageState(labelValue)
}

export async function relabelBrowser(
  this: GatewayRuntimeCore,
  fromValue: unknown,
  toValue: unknown
) {
  return this.browserRuntime.relabelBrowser(fromValue, toValue)
}

export async function closeBrowser(this: GatewayRuntimeCore, labelValue: unknown) {
  return this.browserRuntime.closeBrowser(labelValue)
}

export async function clearBrowserData(this: GatewayRuntimeCore) {
  return this.browserRuntime.clearBrowserData()
}

export async function status(this: GatewayRuntimeCore) {
  const server = await this.server()
  if (this.isRestartingServer(server.id))
    throw new Error('KCoder app-server restart is in progress')
  try {
    await this.controlClient()
  } catch (error) {
    if (!server.security) throw error
    return { running: true, ready: false, deviceId: server.id, accountLoginServerId: server.id }
  }
  return {
    running: true,
    ready: true,
    deviceId: server.id,
    runtimeInstanceId: `kcoder-gateway:${server.id}`,
    // Wework gates device usability on its executor protocol version. The gateway implements
    // that surface independently from the renderer package version.
    version: '1.8.6-kcoder.1',
  }
}

export async function saveAttachment(
  this: GatewayRuntimeCore,
  rawParams: unknown
): Promise<string> {
  return this.remoteSessions.saveAttachment(rawParams)
}

export async function startAttachmentUpload(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.remoteSessions.startAttachmentUpload(rawParams)
}

export async function appendAttachmentUpload(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.remoteSessions.appendAttachmentUpload(rawParams)
}

export async function finishAttachmentUpload(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.remoteSessions.finishAttachmentUpload(rawParams)
}

export async function cancelAttachmentUpload(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.remoteSessions.cancelAttachmentUpload(rawParams)
}

export async function saveAttachmentForIpc(this: GatewayRuntimeCore, rawParams: unknown) {
  const params = record(rawParams)
  const [path, server] = await Promise.all([
    this.saveAttachment(params),
    this.serverForParams(params),
  ])
  return { path, deviceId: server.id }
}

export async function readAttachment(this: GatewayRuntimeCore, rawParams: unknown) {
  return this.remoteSessions.readAttachment(rawParams)
}

export async function startTerminal(
  this: GatewayRuntimeCore,
  deviceId: string,
  cwd?: string
): Promise<DeviceSessionResponse> {
  return this.remoteSessions.startTerminal(deviceId, cwd)
}

export async function restoreTerminal(
  this: GatewayRuntimeCore,
  deviceId: string,
  cwd: string | undefined,
  sessionId: string
): Promise<DeviceSessionResponse> {
  return this.remoteSessions.restoreTerminal(deviceId, cwd, sessionId)
}

export function createTerminalClient(
  this: GatewayRuntimeCore,
  sessionId: string
): RemoteTerminalClient {
  return this.remoteSessions.createTerminalClient(sessionId)
}

export function threadKey(this: GatewayRuntimeCore, serverId: string, threadId: string): string {
  return `${serverId}\0${threadId}`
}

export function resolveTaskId(this: GatewayRuntimeCore, value: string | null): string | null {
  return value ? (this.canonicalTaskByRequested.get(value) ?? value) : null
}

export async function executeDeviceCommand(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  server: GatewayServer
) {
  const command = text(params.command_key)
  if (command === 'runtime_auth_status') {
    return { success: true, exit_code: 0, stdout: { exists: false }, stderr: '' }
  }
  if (command === 'project_workspace_root') {
    return { success: true, exit_code: 0, stdout: `${server.workspacePath ?? '/'}\n`, stderr: '' }
  }
  if (
    command === 'home_dir' ||
    command === 'ls_dirs' ||
    command === 'mkdir_p' ||
    command === 'workspace_tree' ||
    command === 'workspace_read_text_file' ||
    command === 'workspace_read_file_chunk' ||
    command === 'workspace_write_text_file' ||
    command === 'workspace_create_text_file' ||
    command === 'workspace_create_directory' ||
    command === 'workspace_rename_entry' ||
    command === 'workspace_delete_entry'
  ) {
    const client = await this.commandClient(server, this.compatibility.fileWorkspace(params))
    if (client.supportsExperimental?.('workspaceFiles') === false) {
      throw new Error('KCoder app-server 不支持工作区文件访问')
    }
    return client.request('device/execute', params)
  }
  if (command === 'turn_file_changes_review') {
    const { task, client } = await this.taskConnection(params)
    return client.request('device/execute', { ...params, threadId: task.threadId })
  }
  if (command === 'ls_skills') {
    const client = await this.commandClient(server, this.compatibility.skillsWorkspace(params))
    return client.request('device/execute', params)
  }
  if (
    command === 'git_is_worktree' ||
    command === 'git_branch' ||
    command === 'git_branch_diff' ||
    command === 'git_branch_diff_shortstat' ||
    command === 'git_diff_unstaged' ||
    command === 'git_diff_staged' ||
    command === 'git_diff_last_commit' ||
    command === 'git_status_porcelain' ||
    command === 'git_remote_url' ||
    command === 'git_branch_list' ||
    command === 'git_add_all' ||
    command === 'git_commit' ||
    command === 'git_commit_all' ||
    command === 'git_push' ||
    command === 'git_checkout' ||
    command === 'git_checkout_new' ||
    command === 'git_generate_commit_message'
  ) {
    const client = await this.commandClient(server, this.compatibility.fileWorkspace(params))
    return client.request('device/execute', params)
  }
  throw new Error(`KCoder app-server does not implement device command: ${command ?? 'unknown'}`)
}
