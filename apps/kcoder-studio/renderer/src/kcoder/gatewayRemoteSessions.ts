import type {
  RemoteTerminalClient,
  RemoteTerminalExitPayload,
  RemoteTerminalOutputPayload,
} from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
import type { GatewayServer } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'
import {
  ATTACHMENT_CHUNK_BYTES,
  base64ToByteValues,
  downloadGatewayAttachment,
  MAX_GATEWAY_ATTACHMENT_BYTES,
  uploadGatewayAttachment,
} from './gatewayAttachmentTransfer'
import { createRandomUuid } from '@/lib/random-id'

const MAX_BUFFERED_TERMINAL_OUTPUT_BYTES = 256 * 1024
const MAX_TERMINAL_TOMBSTONES = 256

interface StagedGatewayAttachment {
  serverId: string
  filename: string
  mimeType: string
  fileSize: number
  contentBase64: string
}

interface GatewayAttachmentUpload {
  serverId: string
  filename: string
  mimeType: string
  fileSize: number
  client: GatewayClient
  remoteUploadId: string
  nextIndex: number
  receivedBytes: number
  contentBase64: string
}

interface GatewayTerminalState {
  serverId: string
  wireSessionId: string
  publicSessionId: string | null
  client: GatewayClient | null
  bufferedOutput: RemoteTerminalOutputPayload[]
  bufferedOutputBytes: number
  bufferedExit: RemoteTerminalExitPayload | null
  exited: boolean
  outputHandlers: Set<(payload: RemoteTerminalOutputPayload) => void>
  exitHandlers: Set<(payload: RemoteTerminalExitPayload) => void>
}

export interface GatewayRemoteSessionSettings {
  instructions: string
  personality: 'friendly' | 'pragmatic'
}

export interface GatewayRemoteSessionsOptions {
  resolveServer: (params: Record<string, unknown>) => Promise<GatewayServer>
  commandClient: (server: GatewayServer, workspacePath?: string) => Promise<GatewayClient>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function utf8CharacterByteLength(value: string): number {
  const codePoint = value.codePointAt(0)
  if (codePoint === undefined) return 0
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 3
  if (codePoint <= 0xffff) return 3
  return 4
}

function utf8SuffixWithin(value: string, maxBytes: number): { data: string; bytes: number } {
  let bytes = 0
  let start = value.length
  while (start > 0) {
    let characterStart = start - 1
    const tail = value.charCodeAt(characterStart)
    if (tail >= 0xdc00 && tail <= 0xdfff && characterStart > 0) {
      const head = value.charCodeAt(characterStart - 1)
      if (head >= 0xd800 && head <= 0xdbff) characterStart -= 1
    }
    const character = value.slice(characterStart, start)
    const characterBytes = utf8CharacterByteLength(character)
    if (bytes + characterBytes > maxBytes) break
    bytes += characterBytes
    start = characterStart
  }
  return { data: value.slice(start), bytes }
}

export class GatewayRemoteSessions {
  private readonly attachmentByPath = new Map<string, StagedGatewayAttachment>()
  private readonly attachmentUploads = new Map<string, GatewayAttachmentUpload>()
  private readonly terminalByPublicId = new Map<string, GatewayTerminalState>()
  private readonly terminalByWireKey = new Map<string, GatewayTerminalState>()
  private readonly terminalTombstones = new Set<string>()
  private readonly resolveServer: GatewayRemoteSessionsOptions['resolveServer']
  private readonly getCommandClient: GatewayRemoteSessionsOptions['commandClient']

  constructor(options: GatewayRemoteSessionsOptions) {
    this.resolveServer = options.resolveServer
    this.getCommandClient = options.commandClient
  }

  async saveAttachment(rawParams: unknown): Promise<string> {
    const params = record(rawParams)
    const filename = text(params.filename)
    if (!filename || !Array.isArray(params.bytes)) throw new Error('附件名称或内容无效')
    const requestedMimeType = text(params.mimeType)
    const mimeType =
      requestedMimeType && /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
        ? requestedMimeType
        : 'application/octet-stream'
    const fileSize = params.bytes.length
    const server = await this.resolveServer(params)
    const client = await this.getCommandClient(server)
    if (client.supportsExperimental?.('browserAttachments') === false) {
      throw new Error('KCoder app-server 不支持浏览器附件')
    }
    const uploaded = await uploadGatewayAttachment(client, filename, params.bytes)
    const { path, contentBase64 } = uploaded
    this.attachmentByPath.set(this.attachmentKey(server.id, path), {
      serverId: server.id,
      filename,
      mimeType,
      fileSize,
      contentBase64,
    })
    return path
  }

  async startAttachmentUpload(rawParams: unknown): Promise<{ uploadId: string; deviceId: string }> {
    const params = record(rawParams)
    const filename = text(params.filename)
    const fileSize =
      typeof params.fileSize === 'number'
        ? params.fileSize
        : typeof params.size === 'number'
          ? params.size
          : null
    if (
      !filename ||
      fileSize === null ||
      !Number.isSafeInteger(fileSize) ||
      fileSize < 0 ||
      fileSize > MAX_GATEWAY_ATTACHMENT_BYTES
    ) {
      throw new Error('附件名称或大小无效')
    }
    const requestedMimeType = text(params.mimeType)
    const mimeType =
      requestedMimeType && /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
        ? requestedMimeType
        : 'application/octet-stream'
    const server = await this.resolveServer(params)
    const client = await this.getCommandClient(server)
    if (client.supportsExperimental?.('browserAttachments') === false) {
      throw new Error('KCoder app-server 不支持浏览器附件')
    }
    const started = await client.request<{ upload_id?: unknown }>('attachment/upload/start', {
      filename,
      size: fileSize,
    })
    const remoteUploadId = text(started.upload_id)
    if (!remoteUploadId) throw new Error('KCoder app-server 未返回附件上传 ID')
    const uploadId = createRandomUuid()
    this.attachmentUploads.set(uploadId, {
      serverId: server.id,
      filename,
      mimeType,
      fileSize,
      client,
      remoteUploadId,
      nextIndex: 0,
      receivedBytes: 0,
      contentBase64: '',
    })
    return { uploadId, deviceId: server.id }
  }

  async appendAttachmentUpload(rawParams: unknown): Promise<{ receivedBytes: number }> {
    const params = record(rawParams)
    const uploadId = text(params.uploadId)
    const contentBase64 = text(params.contentBase64)
    const index = typeof params.index === 'number' ? params.index : null
    if (!uploadId || !contentBase64 || index === null || !Number.isSafeInteger(index)) {
      throw new Error('附件分块参数无效')
    }
    const upload = this.attachmentUploads.get(uploadId)
    if (!upload) throw new Error('附件上传会话不存在')
    if (index !== upload.nextIndex) throw new Error('附件分块顺序无效')
    const chunkBytes = base64ToByteValues(contentBase64)
    if (chunkBytes.length > ATTACHMENT_CHUNK_BYTES) throw new Error('附件分块过大')
    if (upload.receivedBytes + chunkBytes.length > upload.fileSize) {
      throw new Error('附件分块超出声明大小')
    }
    await upload.client.request('attachment/upload/chunk', {
      upload_id: upload.remoteUploadId,
      index,
      content_base64: contentBase64,
    })
    upload.nextIndex += 1
    upload.receivedBytes += chunkBytes.length
    upload.contentBase64 += contentBase64
    return { receivedBytes: upload.receivedBytes }
  }

  async finishAttachmentUpload(rawParams: unknown): Promise<{ path: string; deviceId: string }> {
    const uploadId = text(record(rawParams).uploadId)
    if (!uploadId) throw new Error('附件上传 ID 无效')
    const upload = this.attachmentUploads.get(uploadId)
    if (!upload) throw new Error('附件上传会话不存在')
    try {
      if (upload.receivedBytes !== upload.fileSize) {
        throw new Error('附件内容不完整')
      }
      const result = await upload.client.request<{ path?: unknown }>('attachment/upload/finish', {
        upload_id: upload.remoteUploadId,
      })
      const path = typeof result.path === 'string' && result.path.trim() ? result.path : null
      if (!path) throw new Error('KCoder app-server 未返回附件路径')
      this.attachmentByPath.set(this.attachmentKey(upload.serverId, path), {
        serverId: upload.serverId,
        filename: upload.filename,
        mimeType: upload.mimeType,
        fileSize: upload.fileSize,
        contentBase64: upload.contentBase64,
      })
      return { path, deviceId: upload.serverId }
    } catch (error) {
      await upload.client
        .request('attachment/upload/cancel', { upload_id: upload.remoteUploadId })
        .catch(() => undefined)
      throw error
    } finally {
      this.attachmentUploads.delete(uploadId)
    }
  }

  async cancelAttachmentUpload(rawParams: unknown): Promise<void> {
    const uploadId = text(record(rawParams).uploadId)
    if (!uploadId) return
    const upload = this.attachmentUploads.get(uploadId)
    if (!upload) return
    this.attachmentUploads.delete(uploadId)
    await upload.client
      .request('attachment/upload/cancel', { upload_id: upload.remoteUploadId })
      .catch(() => undefined)
  }

  async readAttachment(rawParams: unknown): Promise<{
    contentBase64: string
    mimeType: string
    size: number
  }> {
    const params = record(rawParams)
    const path = text(params.path)
    if (!path) throw new Error('附件路径无效')
    const requestedServerId = text(params.deviceId) ?? text(params.device_id)
    const threadId = text(params.threadId) ?? text(params.thread_id)
    if (!threadId) {
      if (!requestedServerId) throw new Error('草稿附件缺少 device 身份')
      const cached = this.attachmentByPath.get(this.attachmentKey(requestedServerId, path))
      if (!cached) throw new Error('草稿附件不属于指定 KCoder 服务器')
      return {
        contentBase64: cached.contentBase64,
        mimeType: cached.mimeType,
        size: cached.fileSize,
      }
    }
    const server = await this.resolveServer(params)
    const workspacePath = text(params.workspacePath) ?? server.workspacePath
    const client = await this.getCommandClient(server, workspacePath)
    const result = await downloadGatewayAttachment(client, threadId, path)
    return {
      contentBase64: result.contentBase64,
      mimeType: text(params.mimeType) ?? 'application/octet-stream',
      size: result.size,
    }
  }

  async startTerminal(deviceId: string, cwd?: string): Promise<DeviceSessionResponse> {
    const server = await this.resolveServer({ deviceId, ...(cwd ? { cwd } : {}) })
    const client = await this.getCommandClient(server, cwd)
    if (client.supportsExperimental?.('terminalSessions') === false) {
      throw new Error('KCoder app-server 不支持终端会话')
    }
    const result = await client.request<{ session_id?: string; cwd?: string }>('terminal/start', {
      cwd: cwd ?? server.workspacePath ?? '/',
      rows: 24,
      cols: 80,
    })
    const sessionId = text(result.session_id)
    if (!sessionId) throw new Error('KCoder app-server 未返回终端 session id')
    const wireKey = this.terminalWireKey(server.id, sessionId)
    if (this.terminalByWireKey.has(wireKey)) {
      throw new Error('KCoder app-server 复用了仍在运行的终端 session id')
    }
    // A successful terminal/start response is the authoritative boundary for a reassigned wire ID; the earlier tombstone only blocks late notifications from the old session.
    this.terminalTombstones.delete(wireKey)
    const state = this.terminalState(sessionId, server.id)
    if (!state) throw new Error('KCoder app-server 返回了已关闭的终端 session id')
    state.client = client
    state.publicSessionId ??= `gateway-terminal:${encodeURIComponent(server.id)}:${sessionId}`
    this.terminalByPublicId.set(state.publicSessionId, state)
    return {
      session_id: state.publicSessionId,
      device_id: server.id,
      type: 'terminal',
      path: text(result.cwd) ?? cwd ?? server.workspacePath ?? '/',
      url: '',
      transport: 'socketio',
      expires_at: null,
    }
  }

  async restoreTerminal(
    deviceId: string,
    cwd: string | undefined,
    publicSessionId: string
  ): Promise<DeviceSessionResponse> {
    const server = await this.resolveServer({ deviceId, ...(cwd ? { cwd } : {}) })
    const prefix = `gateway-terminal:${encodeURIComponent(server.id)}:`
    if (!publicSessionId.startsWith(prefix)) {
      throw new Error('KCoder 终端会话与当前服务器不匹配')
    }
    const wireSessionId = publicSessionId.slice(prefix.length)
    if (!wireSessionId) throw new Error('KCoder 终端 session id 无效')
    const client = await this.getCommandClient(server, cwd)
    if (client.supportsExperimental?.('terminalSessions') === false) {
      throw new Error('KCoder app-server 不支持终端会话')
    }
    const attached = await client.request<{
      session_id?: string
      cwd?: string
      transcript?: string
    }>('terminal/attach', {
      session_id: wireSessionId,
      rows: 24,
      cols: 80,
    })
    if (text(attached.session_id) !== wireSessionId) {
      throw new Error('KCoder app-server 未恢复指定的终端会话')
    }

    const wireKey = this.terminalWireKey(server.id, wireSessionId)
    this.terminalTombstones.delete(wireKey)
    const state = this.terminalState(wireSessionId, server.id)
    if (!state) throw new Error('KCoder 终端会话已经关闭')
    state.client = client
    state.publicSessionId = publicSessionId
    state.exited = false
    state.bufferedExit = null
    state.bufferedOutput = []
    state.bufferedOutputBytes = 0
    const transcript = typeof attached.transcript === 'string' ? attached.transcript : ''
    if (transcript) {
      this.bufferTerminalOutput(state, { session_id: publicSessionId, data: transcript })
    }
    this.terminalByPublicId.set(publicSessionId, state)

    return {
      session_id: publicSessionId,
      device_id: server.id,
      type: 'terminal',
      path: text(attached.cwd) ?? cwd ?? server.workspacePath ?? '/',
      url: '',
      transport: 'socketio',
      expires_at: null,
    }
  }

  createTerminalClient(sessionId: string): RemoteTerminalClient {
    const state = this.terminalByPublicId.get(sessionId)
    if (!state) throw new Error(`KCoder 终端会话不存在：${sessionId}`)
    const forgetTerminal = () => this.forgetTerminal(state)
    const client = () => {
      if (!state.client) throw new Error('KCoder 终端连接尚未就绪')
      return state.client
    }
    return {
      async attach() {
        const buffered = state.bufferedOutput.splice(0)
        state.bufferedOutputBytes = 0
        for (const payload of buffered) {
          for (const handler of state.outputHandlers) {
            handler({ ...payload, session_id: sessionId })
          }
        }
        if (state.bufferedExit) {
          const payload = { ...state.bufferedExit, session_id: sessionId }
          state.bufferedExit = null
          for (const handler of state.exitHandlers) handler(payload)
        }
      },
      async write(data: string) {
        if (state.exited) return
        await client().request('terminal/write', { session_id: state.wireSessionId, data })
      },
      async resize(rows: number, cols: number) {
        if (state.exited) return
        await client().request('terminal/resize', {
          session_id: state.wireSessionId,
          rows,
          cols,
        })
      },
      async close() {
        try {
          if (!state.exited) {
            await client().request('terminal/close', { session_id: state.wireSessionId })
          }
        } finally {
          forgetTerminal()
        }
      },
      onOutput(handler) {
        state.outputHandlers.add(handler)
        return () => state.outputHandlers.delete(handler)
      },
      onExit(handler) {
        state.exitHandlers.add(handler)
        return () => state.exitHandlers.delete(handler)
      },
      dispose: () => undefined,
    }
  }

  private terminalState(sessionId: string, serverId: string): GatewayTerminalState | null {
    const key = this.terminalWireKey(serverId, sessionId)
    if (this.terminalTombstones.has(key)) return null
    const existing = this.terminalByWireKey.get(key)
    if (existing) return existing
    const created: GatewayTerminalState = {
      serverId,
      wireSessionId: sessionId,
      publicSessionId: null,
      client: null,
      bufferedOutput: [],
      bufferedOutputBytes: 0,
      bufferedExit: null,
      exited: false,
      outputHandlers: new Set(),
      exitHandlers: new Set(),
    }
    this.terminalByWireKey.set(key, created)
    return created
  }

  private terminalWireKey(serverId: string, sessionId: string): string {
    return `${serverId}\0${sessionId}`
  }

  private attachmentKey(serverId: string, path: string): string {
    return `${serverId}\0${path}`
  }

  private forgetTerminal(state: GatewayTerminalState) {
    if (state.publicSessionId) this.terminalByPublicId.delete(state.publicSessionId)
    const key = this.terminalWireKey(state.serverId, state.wireSessionId)
    this.terminalByWireKey.delete(key)
    state.client = null
    state.bufferedOutput.splice(0)
    state.bufferedOutputBytes = 0
    state.bufferedExit = null
    state.outputHandlers.clear()
    state.exitHandlers.clear()
    this.terminalTombstones.add(key)
    while (this.terminalTombstones.size > MAX_TERMINAL_TOMBSTONES) {
      const oldest = this.terminalTombstones.values().next().value
      if (typeof oldest !== 'string') break
      this.terminalTombstones.delete(oldest)
    }
  }

  private bufferTerminalOutput(state: GatewayTerminalState, payload: RemoteTerminalOutputPayload) {
    // The buffer retains the newest complete UTF-8 suffix and evicts from the oldest output prefix when over limit.
    const suffix = utf8SuffixWithin(payload.data, MAX_BUFFERED_TERMINAL_OUTPUT_BYTES)
    if (suffix.bytes === 0) return
    state.bufferedOutput.push({ ...payload, data: suffix.data })
    state.bufferedOutputBytes += suffix.bytes
    while (
      state.bufferedOutput.length > 0 &&
      state.bufferedOutputBytes > MAX_BUFFERED_TERMINAL_OUTPUT_BYTES
    ) {
      const oldest = state.bufferedOutput[0]
      const oldestBytes = utf8ByteLength(oldest.data)
      const excess = state.bufferedOutputBytes - MAX_BUFFERED_TERMINAL_OUTPUT_BYTES
      if (oldestBytes <= excess) {
        state.bufferedOutput.shift()
        state.bufferedOutputBytes -= oldestBytes
        continue
      }
      const retained = utf8SuffixWithin(oldest.data, oldestBytes - excess)
      oldest.data = retained.data
      state.bufferedOutputBytes += retained.bytes - oldestBytes
    }
  }

  promptWithAttachments(
    prompt: string,
    execution: Record<string, unknown>,
    server: GatewayServer,
    settings: GatewayRemoteSessionSettings,
    replacementPaths: ReadonlyMap<string, string> = new Map()
  ): string {
    const attachments = Array.isArray(execution.attachments) ? execution.attachments : []
    const lines = attachments.map(value => {
      const attachment = record(value)
      const path = text(attachment.local_path) ?? text(attachment.localPath)
      if (!path) throw new Error('附件缺少目标机路径')
      const staged = this.attachmentByPath.get(this.attachmentKey(server.id, path))
      if (!staged) {
        throw new Error(`附件不属于当前 KCoder 服务器：${server.id}`)
      }
      // Do not trust attachment metadata repeated by the caller. The filename was validated and
      // bound to this exact staged path by attachment/save; caller-controlled newlines here could
      // otherwise escape the structured prompt block.
      return JSON.stringify({
        filename: staged.filename,
        mimeType: staged.mimeType,
        fileSize: staged.fileSize,
        path: replacementPaths.get(path) ?? path,
      })
    })
    const withAttachments =
      lines.length > 0
        ? `${prompt}\n\n<kcoder_attachments version="1">\n${lines.join('\n')}\n</kcoder_attachments>`
        : prompt
    const { instructions: rawInstructions, personality } = settings
    const instructions = rawInstructions.trim()
    if (!instructions && personality === 'pragmatic') return withAttachments
    return `<kcoder_client_context personality="${personality}">\n${instructions}\n</kcoder_client_context>\n\n${withAttachments}`
  }

  async promptWithAttachmentsForClient(
    prompt: string,
    execution: Record<string, unknown>,
    server: GatewayServer,
    client: GatewayClient,
    settings: GatewayRemoteSessionSettings,
    ownerThreadId?: string
  ): Promise<string> {
    const attachments = Array.isArray(execution.attachments) ? execution.attachments : []
    const replacementPaths = new Map<string, string>()
    for (const value of attachments) {
      const path = text(record(value).local_path) ?? text(record(value).localPath)
      if (!path) throw new Error('附件缺少目标机路径')
      let staged = this.attachmentByPath.get(this.attachmentKey(server.id, path))
      const attachmentThreadId =
        text(record(value).runtime_thread_id) ?? text(record(value).runtimeThreadId)
      if (attachmentThreadId && attachmentThreadId !== ownerThreadId) {
        throw new Error('历史附件所属 thread 与当前任务不一致')
      }
      if (attachmentThreadId && ownerThreadId) {
        const historical = await downloadGatewayAttachment(client, ownerThreadId, path)
        const contentBase64 = historical.contentBase64
        const filename = text(record(value).filename)
        if (!contentBase64 || !filename) throw new Error('历史附件内容或名称无效')
        const requestedMimeType = text(record(value).mime_type) ?? text(record(value).mimeType)
        staged = {
          serverId: server.id,
          filename,
          mimeType:
            requestedMimeType && /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
              ? requestedMimeType
              : 'application/octet-stream',
          fileSize: historical.size,
          contentBase64,
        }
        this.attachmentByPath.set(this.attachmentKey(server.id, path), staged)
      }
      if (!staged) throw new Error(`附件不属于当前 KCoder 服务器：${server.id}`)
      const uploaded = await uploadGatewayAttachment(
        client,
        staged.filename,
        base64ToByteValues(staged.contentBase64)
      )
      replacementPaths.set(path, uploaded.path)
    }
    return this.promptWithAttachments(prompt, execution, server, settings, replacementPaths)
  }
  handleCommandClientClose(serverId: string, client: GatewayClient) {
    const attachmentPrefix = `${serverId}\0`
    for (const key of this.attachmentByPath.keys()) {
      if (key.startsWith(attachmentPrefix)) this.attachmentByPath.delete(key)
    }
    for (const [uploadId, upload] of this.attachmentUploads) {
      if (upload.serverId === serverId && upload.client === client) {
        this.attachmentUploads.delete(uploadId)
      }
    }
    for (const state of this.terminalByWireKey.values()) {
      if (state.serverId !== serverId || state.client !== client || state.exited) continue
      state.exited = true
      state.client = null
      const payload = { session_id: state.publicSessionId ?? state.wireSessionId, exit_code: null }
      if (state.exitHandlers.size === 0) state.bufferedExit = payload
      else for (const handler of state.exitHandlers) handler(payload)
    }
  }

  handleNotification(
    method: string,
    params: Record<string, unknown>,
    sourceServerId?: string
  ): boolean {
    if (method === 'terminal/output') {
      const sessionId = text(params.session_id)
      const data = typeof params.data === 'string' ? params.data : ''
      if (!sessionId || !sourceServerId || !data) return true
      const state = this.terminalState(sessionId, sourceServerId)
      if (!state) return true
      const payload = { session_id: state.publicSessionId ?? sessionId, data }
      if (state.outputHandlers.size === 0) {
        this.bufferTerminalOutput(state, payload)
      } else for (const handler of state.outputHandlers) handler(payload)
      return true
    }
    if (method === 'terminal/exit') {
      const sessionId = text(params.session_id)
      if (!sessionId || !sourceServerId) return true
      const state = this.terminalState(sessionId, sourceServerId)
      if (!state) return true
      state.exited = true
      const payload = {
        session_id: state.publicSessionId ?? sessionId,
        exit_code: typeof params.exit_code === 'number' ? params.exit_code : null,
      }
      if (state.exitHandlers.size === 0) state.bufferedExit = payload
      else for (const handler of state.exitHandlers) handler(payload)
      return true
    }
    return false
  }

  invalidateTarget(targetId: string): void {
    for (const key of this.attachmentByPath.keys()) if (key.startsWith(`${targetId}\0`)) this.attachmentByPath.delete(key)
    for (const [key, upload] of this.attachmentUploads) if (upload.serverId === targetId) this.attachmentUploads.delete(key)
    for (const [key, terminal] of this.terminalByWireKey) {
      if (terminal.serverId !== targetId) continue
      terminal.bufferedOutput = []
      this.terminalByWireKey.delete(key)
      if (terminal.publicSessionId) this.terminalByPublicId.delete(terminal.publicSessionId)
    }
  }

  dispose() {
    this.attachmentByPath.clear()
    this.attachmentUploads.clear()
    this.terminalByPublicId.clear()
    this.terminalByWireKey.clear()
    this.terminalTombstones.clear()
  }
}
