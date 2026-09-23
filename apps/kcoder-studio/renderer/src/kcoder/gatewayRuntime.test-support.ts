import { listen } from '@tauri-apps/api/event'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { GatewayServer } from './gatewayRpc'
import { KCoderGatewayRuntime, type KCoderGatewayRuntimeOptions } from './gatewayRuntime'
import { installGatewayIpc } from './gatewayRuntimeInstall'

export class FakeGatewayClient extends EventTarget {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly responses: Array<{ id: number; result?: unknown; error?: unknown }> = []
  interruptResult = true
  threadResumeSupported = false
  agentSteeringSupported = true
  agentSummaries: Array<Record<string, unknown>> = []
  resumeGate: Promise<void> | null = null
  connectGate: Promise<void> | null = null
  browserStartGate: Promise<void> | null = null
  browserCloseGate: Promise<void> | null = null
  resumeFailure: Error | null = null
  metadataUpdateFailure: Error | null = null
  persistedThreads: Array<Record<string, unknown>> = []
  archivedThreads: Array<Record<string, unknown>> = []
  threadReadFailures = 0
  threadReadPages: Array<Record<string, unknown>> | null = null
  closed = false
  goal: Record<string, unknown> | null = null
  goalGetFailures: Error[] = []
  rollbackFailedFiles = 0
  rollbackRemovedMessages = 2
  respondFailure: Error | null = null
  workspaceItems: Array<Record<string, unknown>> = []
  worktreeItems: Array<Record<string, unknown>> = []
  sharedRuntimeContext = {
    instructions: '',
    personality: 'pragmatic' as 'friendly' | 'pragmatic',
    instructionsConfigured: false,
    personalityConfigured: false,
    configPath: null as string | null,
  }
  onContextGet: (() => void) | null = null
  threadMessages: Array<Record<string, unknown>> = [
    {
      id: 'history-message-1',
      turnId: 'turn-1',
      role: 'user',
      content: '之前的问题',
      blocks: [{ id: 'thinking-1', type: 'thinking', content: '已分析', status: 'done' }],
      timestampMs: 1700000000500,
    },
  ]
  private readonly threadId: string | null

  constructor(threadId: string | null) {
    super()
    this.threadId = threadId
  }

  async connect() {
    if (this.connectGate) await this.connectGate
  }

  close() {
    this.closed = true
    this.dispatchEvent(new Event('close'))
  }

  supportsThreadResume() {
    return this.threadResumeSupported
  }

  supportsExperimental(capability: string) {
    if (capability === 'threadIndexedPagesV1') return this.indexedPagesSupported
    if (capability === 'threadListCompleteness') return false
    return capability === 'agentSteering' ? this.agentSteeringSupported : true
  }

  indexedPagesSupported = false

  respond(id: number, result: unknown) {
    if (this.respondFailure) throw this.respondFailure
    this.responses.push({ id, result })
  }

  respondError(id: number, code: number, message: string, data?: unknown) {
    this.responses.push({ id, error: { code, message, data } })
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'thread/start')
      return (this.threadId ? { thread: { id: this.threadId } } : {}) as T
    if (method === 'thread/list') {
      const start = Number(params.cursor ?? 0)
      const limit = Number(params.limit ?? 100)
      const source = params.archived === true ? this.archivedThreads : this.persistedThreads
      const threads = source.slice(start, start + limit)
      return {
        threads,
        nextCursor: start + threads.length < source.length ? String(start + threads.length) : null,
      } as T
    }
    if (method === 'thread/read' || method === 'thread/read/indexed') {
      if (this.threadReadFailures > 0) {
        this.threadReadFailures -= 1
        throw new Error('persisted thread not found: test history')
      }
      if (this.threadReadPages) {
        const page = this.threadReadPages.shift()
        if (!page) throw new Error('unexpected extra transcript page request')
        return page as T
      }
      return {
        messages: this.threadMessages,
        rangeStart: 0,
        rangeEnd: 1,
        hasMoreBefore: false,
        beforeCursor: null,
      } as T
    }
    if (method === 'thread/resume') {
      if (this.resumeGate) await this.resumeGate
      if (this.resumeFailure) throw this.resumeFailure
      return { thread: { id: params.threadId } } as T
    }
    if (method === 'thread/metadata/update') {
      if (this.metadataUpdateFailure) throw this.metadataUpdateFailure
      const thread = this.persistedThreads.find(item => item.id === params.threadId) ?? {
        id: params.threadId,
        cwd: '/workspace',
        status: 'idle',
      }
      const previousMetadata =
        typeof thread.metadata === 'object' && thread.metadata !== null
          ? (thread.metadata as Record<string, unknown>)
          : {}
      for (const field of ['title', 'model', 'archivedAt', 'parent'] as const) {
        if (!(field in params)) continue
        if (params[field] === null) delete thread[field]
        else thread[field] = params[field]
      }
      thread.metadata = {
        schema: 'kcoder.thread-metadata',
        version: 1,
        revision: Number(previousMetadata.revision ?? 0) + 1,
        title: 'title' in params ? params.title : (previousMetadata.title ?? thread.title ?? null),
        model: 'model' in params ? params.model : (previousMetadata.model ?? thread.model ?? null),
        archivedAt:
          'archivedAt' in params
            ? params.archivedAt
            : (previousMetadata.archivedAt ?? thread.archivedAt ?? null),
        parent:
          'parent' in params ? params.parent : (previousMetadata.parent ?? thread.parent ?? null),
      }
      thread.updatedAt = String(Date.now())
      if (!this.persistedThreads.includes(thread)) this.persistedThreads.push(thread)
      return { thread } as T
    }
    if (method === 'thread/fork') {
      return { thread: { id: `${this.threadId ?? 'thread'}-fork` } } as T
    }
    if (method === 'agent/steer') {
      return {
        agentId: params.agentId,
        messageId: 'msg-steer-1',
        status: 'queued_live',
        queued: true,
        queuePosition: 1,
        clientMessageId: params.clientMessageId,
      } as T
    }
    if (method === 'agent/list') {
      return { threadId: params.threadId, agents: this.agentSummaries } as T
    }
    if (method === 'thread/compact') {
      return { threadId: params.threadId, compacted: true, preTokens: 100, postTokens: 40 } as T
    }
    if (method === 'thread/rollback') {
      return {
        threadId: params.threadId,
        turn: 1,
        removedMessages: this.rollbackRemovedMessages,
        failedFiles: this.rollbackFailedFiles,
      } as T
    }
    if (method === 'thread/goal/get') {
      const failure = this.goalGetFailures.shift()
      if (failure) throw failure
      return { threadId: params.threadId, goal: this.goal } as T
    }
    if (method === 'thread/goal/set') {
      const tokenBudget =
        params.clearTokenBudget === true
          ? null
          : (params.tokenBudget ?? this.goal?.tokenBudget ?? null)
      this.goal = {
        threadId: params.threadId,
        objective: params.objective ?? this.goal?.objective ?? '',
        mode: params.mode ?? this.goal?.mode ?? 'standard',
        verificationKind: params.verificationKind ?? this.goal?.verificationKind ?? 'artifact',
        status: params.status ?? this.goal?.status ?? 'active',
        tokenBudget,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      return { threadId: params.threadId, goal: this.goal } as T
    }
    if (method === 'thread/goal/clear') {
      const cleared = this.goal !== null
      this.goal = null
      return { threadId: params.threadId, cleared } as T
    }
    if (method === 'thread/delete') {
      return { threadId: params.threadId, deleted: true, deletedFiles: 3 } as T
    }
    if (method === 'runtime.models.list') {
      return {
        data: [{ id: 'profile::model', model: 'model' }],
        providers: [{ id: 'profile', current: true, available: true }],
      } as T
    }
    if (method === 'runtime.context.get') {
      const result = { ...this.sharedRuntimeContext }
      this.onContextGet?.()
      return result as T
    }
    if (method === 'runtime.context.update') {
      if (
        typeof params.instructions === 'string' &&
        (params.onlyIfUnconfigured !== true || !this.sharedRuntimeContext.instructionsConfigured)
      ) {
        this.sharedRuntimeContext.instructions = params.instructions
        this.sharedRuntimeContext.instructionsConfigured = true
      }
      if (
        (params.personality === 'friendly' || params.personality === 'pragmatic') &&
        (params.onlyIfUnconfigured !== true || !this.sharedRuntimeContext.personalityConfigured)
      ) {
        this.sharedRuntimeContext.personality = params.personality
        this.sharedRuntimeContext.personalityConfigured = true
      }
      return { ...this.sharedRuntimeContext } as T
    }
    if (method === 'runtime.workspace.search') {
      return {
        files: [
          {
            root: params.root,
            path: 'src/main.rs',
            fileName: 'main.rs',
            matchType: 'file',
            score: 100,
            indices: [4, 5, 6, 7],
          },
        ],
      } as T
    }
    if (method === 'runtime.workspaces.list') {
      return { success: true, items: this.workspaceItems, pinnedTaskIds: [], taskOrders: {} } as T
    }
    if (method === 'runtime.worktrees.list') {
      return { success: true, items: this.worktreeItems } as T
    }
    if (method === 'runtime.worktrees.delete') {
      const item = this.worktreeItems.find(value => value.path === params.path)
      if (item) {
        item.state = params.preserveSnapshot === false ? 'deleted' : 'restorable'
        if (Array.isArray(params.archivedConversations)) {
          item.conversations = params.archivedConversations
        }
      }
      return { success: true, worktree: item ?? { path: params.path, state: 'restorable' } } as T
    }
    if (method === 'runtime.worktrees.restore') {
      const item = this.worktreeItems.find(value => value.path === params.path)
      if (item) {
        if (params.expectedRevision !== item.revision) throw new Error('stale worktree revision')
        item.state = 'active'
        item.revision = Number(item.revision ?? 0) + 2
      }
      return { success: true, worktree: item ?? { path: params.path, state: 'active' } } as T
    }
    if (method === 'runtime.worktrees.conversations.remove') {
      const item = this.worktreeItems.find(value => value.path === params.path)
      const conversations = Array.isArray(item?.conversations) ? item.conversations : []
      if (item) {
        item.conversations = conversations.filter(
          conversation =>
            !conversation ||
            typeof conversation !== 'object' ||
            (conversation as Record<string, unknown>).taskId !== params.taskId
        )
      }
      return { success: true, accepted: true, removed: true } as T
    }
    if (method === 'runtime.worktrees.conversations.link') {
      const item = this.worktreeItems.find(value => value.path === params.path)
      const conversation = params.conversation
      if (item && conversation && typeof conversation === 'object') {
        const conversations = Array.isArray(item.conversations) ? item.conversations : []
        item.conversations = [
          ...conversations.filter(
            existing =>
              !existing ||
              typeof existing !== 'object' ||
              (existing as Record<string, unknown>).taskId !==
                (conversation as Record<string, unknown>).taskId
          ),
          conversation as Record<string, unknown>,
        ]
      }
      return { success: true, accepted: true, linked: true } as T
    }
    if (
      method.startsWith('runtime.workspaces.') ||
      method.startsWith('runtime.projects.') ||
      method.startsWith('runtime.sidebar.')
    ) {
      return { success: true, accepted: true, deviceId: params.deviceId ?? 'local' } as T
    }
    if (method === 'turn/start') return { turn: { id: params.retryFromTurnId ?? `${this.threadId}-turn`,
      ...(params.retryFromAttemptId ? { attemptId: `${params.retryFromAttemptId}-next` } : {}),
    } } as T
    if (method === 'turn/interrupt') return { interrupted: this.interruptResult } as T
    if (method === 'gateway/client/detach') return { detached: true } as T
    if (method === 'gateway/app-server/restart') {
      return { restarted: false, stopped: true, reconnectRequired: true } as T
    }
    if (method === 'device/execute') {
      if (params.command_key === 'home_dir') {
        return { success: true, exit_code: 0, stdout: '/home/test\n', stderr: '' } as T
      }
      if (params.command_key === 'turn_file_changes_revert') {
        return {
          success: true,
          exit_code: 0,
          stdout: {
            success: true,
            file_changes: {
              version: 1,
              status: 'reverted',
              artifact_id: Array.isArray(params.args) ? params.args[0] : '',
              device_id: 'kcoder',
              workspace_path: params.path,
              file_count: 1,
              additions: 1,
              deletions: 0,
              files: [],
              revertible: false,
            },
          },
          stderr: '',
        } as T
      }
      return {
        success: true,
        exit_code: 0,
        stdout: { path: params.path, entries: [] },
        stderr: '',
      } as T
    }
    if (method === 'attachment/save') return { path: `/tmp/${String(params.filename)}` } as T
    if (method === 'terminal/start') {
      return { session_id: `${this.threadId ?? 'command'}-terminal`, cwd: params.cwd } as T
    }
    if (method === 'terminal/resize' || method === 'terminal/write') {
      return { accepted: true } as T
    }
    if (method === 'terminal/close') return { closed: true } as T
    if (method === 'runtime.worktrees.settings.get') {
      return { success: true, settings: {} } as T
    }
    if (method === 'runtime.worktrees.prepare') {
      return { success: true, accepted: true } as T
    }
    if (method === 'runtime.worktrees.archive') {
      return { success: true, accepted: true } as T
    }
    if (method === 'browser/start') {
      if (this.browserStartGate) await this.browserStartGate
      return {
        session_id: `${this.threadId ?? 'command'}-browser`,
        url: params.url,
        width: Math.max(320, Math.min(1920, Number(params.width))),
        height: Math.max(240, Math.min(1080, Number(params.height))),
      } as T
    }
    if (method === 'browser/screenshot') {
      return {
        session_id: params.session_id,
        data_base64: 'YWJj',
        mime_type: 'image/jpeg',
        width: 320,
        height: 240,
        page: {
          url: 'https://example.test/ready',
          title: 'Remote example',
          faviconUrl: 'https://example.test/favicon.ico',
        },
      } as T
    }
    if (method === 'browser/action') {
      return {
        accepted: true,
        page:
          params.action === 'navigate'
            ? { url: params.url, title: 'Navigated', faviconUrl: null }
            : undefined,
      } as T
    }
    if (method === 'browser/evaluate') return { value: { ok: true } } as T
    if (method === 'browser/close') {
      if (this.browserCloseGate) await this.browserCloseGate
      return { closed: true } as T
    }
    throw new Error(`FakeGatewayClient 未建模 RPC：${method}`)
  }

  emitNotification(method: string, params: Record<string, unknown>) {
    this.dispatchEvent(new CustomEvent('notification', { detail: { method, params } }))
  }
}

const runtimes = new Set<KCoderGatewayRuntime>()
const emittedGatewayEvents: unknown[] = []
let cleanupIpc: (() => void) | null = null
let unlistenGatewayEvents: (() => void) | null = null
let consoleError: ReturnType<typeof vi.spyOn> | null = null
let consoleWarn: ReturnType<typeof vi.spyOn> | null = null

beforeEach(async () => {
  emittedGatewayEvents.splice(0)
  cleanupIpc = installGatewayIpc(command => {
    throw new Error(`测试未声明的 Tauri IPC：${command}`)
  })
  unlistenGatewayEvents = await listen('local-executor:event', event => {
    emittedGatewayEvents.push(event.payload)
  })
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

export function localGatewayServer(overrides: Partial<GatewayServer> = {}): GatewayServer {
  return {
    id: 'local',
    label: '当前虚拟机',
    description: '本机',
    runtime: 'kcoder',
    transport: 'local',
    workspacePath: '/workspace',
    ...overrides,
  }
}

export function createTestGatewayRuntime(
  token = 'token',
  options: KCoderGatewayRuntimeOptions = {}
): KCoderGatewayRuntime {
  const runtime = new KCoderGatewayRuntime(token, options)
  runtimes.add(runtime)
  return runtime
}

afterEach(async () => {
  let teardownError: unknown
  try {
    await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  } catch (error) {
    teardownError = error
  } finally {
    runtimes.clear()
  }
  const unexpectedErrors =
    consoleError?.mock.calls.map((args: unknown[]) => args.map(String).join(' ')) ?? []
  const unexpectedWarnings =
    consoleWarn?.mock.calls.map((args: unknown[]) => args.map(String).join(' ')) ?? []
  for (const event of emittedGatewayEvents) {
    expect(event, 'runtime emit 必须包含稳定的 event 与 payload').toEqual(
      expect.objectContaining({ event: expect.any(String), payload: expect.any(Object) })
    )
  }
  unlistenGatewayEvents?.()
  unlistenGatewayEvents = null
  cleanupIpc?.()
  cleanupIpc = null
  vi.restoreAllMocks()
  localStorage.clear()
  if (teardownError) throw teardownError
  expect(unexpectedErrors, 'runtime 测试不应产生 console.error').toEqual([])
  expect(unexpectedWarnings, 'runtime 测试不应产生 console.warn/Tauri callback warning').toEqual([])
})
