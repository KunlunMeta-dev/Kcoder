import type { GatewayServer } from './gatewayRpc'
import { assertRemoteBrowserAvailable } from './gatewayBrowserPreflight'
import type { GatewayClient } from './gatewayRuntimeTypes'

const MAX_REMOTE_BROWSER_SESSIONS = 4
const REMOTE_BROWSER_FRAME_INTERVAL_MS = 250

interface GatewayBrowserPageState {
  url: string | null
  title: string | null
  faviconUrl: string | null
}

interface GatewayBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

interface GatewayBrowserInputEntry {
  action: Record<string, unknown>
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
}

interface GatewayBrowserState {
  label: string
  nativeLabel: string
  serverId: string
  wireSessionId: string
  client: GatewayClient
  surface: HTMLImageElement
  page: GatewayBrowserPageState
  bounds: GatewayBrowserBounds
  viewportWidth: number
  viewportHeight: number
  visible: boolean
  connected: boolean
  closed: boolean
  frameInFlight: boolean
  frameQueued: boolean
  frameTimer: number | null
  lastPointerMoveAt: number
  inputQueue: GatewayBrowserInputEntry[]
  inputProcessing: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function browserBounds(value: unknown): GatewayBrowserBounds {
  const bounds = record(value)
  return {
    x: Math.max(0, finiteNumber(bounds.x)),
    y: Math.max(0, finiteNumber(bounds.y)),
    width: Math.max(1, finiteNumber(bounds.width, 1)),
    height: Math.max(1, finiteNumber(bounds.height, 1)),
  }
}

export interface GatewayBrowserRuntimeOptions {
  resolveServerForLabel: (label: string) => Promise<GatewayServer>
  connectBrowserClient: (server: GatewayServer) => Promise<GatewayClient>
}

export class GatewayBrowserRuntime {
  private disposed = false
  private readonly browserByLabel = new Map<string, GatewayBrowserState>()
  private readonly browserOpeningByLabel = new Map<
    string,
    Promise<ReturnType<GatewayBrowserRuntime['browserPageResult']>>
  >()
  private readonly resolveServerForLabel: GatewayBrowserRuntimeOptions['resolveServerForLabel']
  private readonly connectBrowserClient: GatewayBrowserRuntimeOptions['connectBrowserClient']

  constructor(options: GatewayBrowserRuntimeOptions) {
    this.resolveServerForLabel = options.resolveServerForLabel
    this.connectBrowserClient = options.connectBrowserClient
  }

  private browserPageResult(state: GatewayBrowserState) {
    return {
      nativeLabel: state.nativeLabel,
      title: state.page.title,
      url: state.page.url,
    }
  }

  private applyBrowserBounds(
    state: GatewayBrowserState,
    bounds: GatewayBrowserBounds,
    visible: boolean
  ) {
    state.bounds = bounds
    state.visible = visible
    Object.assign(state.surface.style, {
      left: `${Math.round(bounds.x)}px`,
      top: `${Math.round(bounds.y)}px`,
      width: `${Math.round(bounds.width)}px`,
      height: `${Math.round(bounds.height)}px`,
      display: visible ? 'block' : 'none',
      pointerEvents:
        visible && state.connected && state.surface.dataset.frameReady === 'true' ? 'auto' : 'none',
    })
  }

  private browserPoint(state: GatewayBrowserState, event: PointerEvent | WheelEvent) {
    const rect = state.surface.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(
          state.viewportWidth - 1,
          ((event.clientX - rect.left) / Math.max(1, rect.width)) * state.viewportWidth
        )
      ),
      y: Math.max(
        0,
        Math.min(
          state.viewportHeight - 1,
          ((event.clientY - rect.top) / Math.max(1, rect.height)) * state.viewportHeight
        )
      ),
    }
  }

  private queueBrowserFrame(state: GatewayBrowserState, immediate = false) {
    if (state.closed || !state.connected || !state.visible) return
    if (state.frameInFlight) {
      state.frameQueued = true
      return
    }
    if (state.frameTimer !== null) window.clearTimeout(state.frameTimer)
    state.frameTimer = window.setTimeout(
      () => {
        state.frameTimer = null
        void this.pollBrowserFrame(state)
      },
      immediate ? 0 : REMOTE_BROWSER_FRAME_INTERVAL_MS
    )
  }

  private async pollBrowserFrame(state: GatewayBrowserState) {
    if (state.closed || !state.connected || !state.visible || state.frameInFlight) return
    state.frameInFlight = true
    state.frameQueued = false
    try {
      const result = await state.client.request<{
        session_id?: string
        data_base64?: string
        mime_type?: string
        width?: number
        height?: number
        page?: { url?: string; title?: string | null; faviconUrl?: string | null }
      }>('browser/screenshot', { session_id: state.wireSessionId })
      if (state.closed || text(result.session_id) !== state.wireSessionId) return
      const data = text(result.data_base64)
      const mimeType = text(result.mime_type)
      if (!data || !mimeType?.startsWith('image/')) throw new Error('远程浏览器返回了无效画面')
      state.surface.src = `data:${mimeType};base64,${data}`
      if (typeof result.width === 'number') state.viewportWidth = result.width
      if (typeof result.height === 'number') state.viewportHeight = result.height
      const page = record(result.page)
      state.page = {
        url: text(page.url) ?? state.page.url,
        title: typeof page.title === 'string' ? page.title : null,
        faviconUrl: typeof page.faviconUrl === 'string' ? page.faviconUrl : null,
      }
      state.surface.dataset.pageUrl = state.page.url ?? ''
      state.surface.dataset.frameReady = 'true'
      state.surface.dataset.connection = 'connected'
      state.surface.style.opacity = '1'
      state.surface.style.pointerEvents = state.visible && state.connected ? 'auto' : 'none'
      delete state.surface.dataset.frameError
    } catch (error) {
      if (!state.closed) state.surface.dataset.frameError = String(error)
    } finally {
      state.frameInFlight = false
      if (!state.closed && state.connected && state.visible) {
        this.queueBrowserFrame(state, state.frameQueued)
      }
    }
  }

  private async sendBrowserAction(state: GatewayBrowserState, action: Record<string, unknown>) {
    if (state.closed) return
    const result = await state.client.request<{
      page?: { url?: string; title?: string | null; faviconUrl?: string | null }
    }>('browser/action', { session_id: state.wireSessionId, ...action })
    if (result.page) {
      state.page = {
        url: text(result.page.url) ?? state.page.url,
        title: typeof result.page.title === 'string' ? result.page.title : null,
        faviconUrl: typeof result.page.faviconUrl === 'string' ? result.page.faviconUrl : null,
      }
    }
    this.queueBrowserFrame(state, true)
  }

  private queueBrowserInput(
    state: GatewayBrowserState,
    action: Record<string, unknown>
  ): Promise<void> {
    if (state.closed || !state.connected) {
      return Promise.reject(new Error('KCoder 远程浏览器连接已断开'))
    }
    const completion = new Promise<void>((resolve, reject) => {
      const tail = state.inputQueue.at(-1)
      if (tail && tail.action.action === action.action && action.action === 'pointer_move') {
        tail.action = action
        tail.waiters.push({ resolve, reject })
        return
      }
      if (tail && tail.action.action === 'wheel' && action.action === 'wheel') {
        tail.action = {
          ...action,
          delta_x: finiteNumber(tail.action.delta_x) + finiteNumber(action.delta_x),
          delta_y: finiteNumber(tail.action.delta_y) + finiteNumber(action.delta_y),
        }
        tail.waiters.push({ resolve, reject })
        return
      }
      if (state.inputQueue.length >= 64) {
        const expendable = state.inputQueue.findIndex(entry =>
          ['pointer_move', 'wheel'].includes(String(entry.action.action))
        )
        if (expendable >= 0) {
          for (const waiter of state.inputQueue.splice(expendable, 1)[0].waiters) waiter.resolve()
        } else {
          reject(new Error('远程浏览器输入队列已满，请稍后重试'))
          return
        }
      }
      state.inputQueue.push({ action, waiters: [{ resolve, reject }] })
    })
    this.processBrowserInput(state)
    return completion
  }

  private processBrowserInput(state: GatewayBrowserState) {
    if (state.inputProcessing) return
    state.inputProcessing = true
    void (async () => {
      try {
        while (!state.closed && state.inputQueue.length > 0) {
          const next = state.inputQueue.shift()
          if (!next) continue
          try {
            await this.sendBrowserAction(state, next.action)
            for (const waiter of next.waiters) waiter.resolve()
          } catch (error) {
            for (const waiter of next.waiters) waiter.reject(error)
            throw error
          }
        }
      } catch (error) {
        for (const entry of state.inputQueue.splice(0)) {
          for (const waiter of entry.waiters) waiter.reject(error)
        }
        if (!state.closed) state.surface.dataset.frameError = String(error)
      } finally {
        state.inputProcessing = false
        if (!state.closed && state.connected && state.inputQueue.length > 0)
          this.processBrowserInput(state)
      }
    })()
  }

  private createBrowserSurface(state: GatewayBrowserState): HTMLImageElement {
    const surface = document.createElement('img')
    surface.alt = 'KCoder remote browser surface'
    surface.tabIndex = 0
    surface.draggable = false
    surface.dataset.testid = 'kcoder-remote-browser-surface'
    surface.dataset.browserLabel = state.label
    Object.assign(surface.style, {
      position: 'fixed',
      zIndex: '20',
      border: '0',
      margin: '0',
      padding: '0',
      objectFit: 'fill',
      opacity: '0',
      userSelect: 'none',
      outline: 'none',
      background: 'var(--background, #fff)',
    })
    surface.addEventListener('pointerdown', event => {
      event.preventDefault()
      surface.focus()
      surface.setPointerCapture?.(event.pointerId)
      const point = this.browserPoint(state, event)
      void this.queueBrowserInput(state, { action: 'pointer_down', ...point }).catch(
        () => undefined
      )
    })
    surface.addEventListener('pointermove', event => {
      const now = performance.now()
      if (now - state.lastPointerMoveAt < 50) return
      state.lastPointerMoveAt = now
      const point = this.browserPoint(state, event)
      void this.queueBrowserInput(state, { action: 'pointer_move', ...point }).catch(
        () => undefined
      )
    })
    surface.addEventListener('pointerup', event => {
      event.preventDefault()
      const point = this.browserPoint(state, event)
      void this.queueBrowserInput(state, { action: 'pointer_up', ...point }).catch(() => undefined)
    })
    surface.addEventListener(
      'wheel',
      event => {
        event.preventDefault()
        const point = this.browserPoint(state, event)
        void this.queueBrowserInput(state, {
          action: 'wheel',
          ...point,
          delta_x: event.deltaX,
          delta_y: event.deltaY,
        }).catch(() => undefined)
      },
      { passive: false }
    )
    surface.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      void this.queueBrowserInput(
        state,
        event.key.length === 1
          ? { action: 'text', text: event.key }
          : { action: 'key', key: event.key }
      ).catch(() => undefined)
    })
    surface.addEventListener('paste', event => {
      event.preventDefault()
      const value = event.clipboardData?.getData('text/plain') ?? ''
      if (value)
        void this.queueBrowserInput(state, { action: 'text', text: value }).catch(() => undefined)
    })
    surface.addEventListener('contextmenu', event => event.preventDefault())
    return surface
  }

  async openBrowser(rawParams: unknown) {
    const params = record(rawParams)
    const label = text(params.label) ?? 'workspace-browser'
    const url = text(params.url)
    if (!url) throw new Error('浏览器 URL 无效')
    if (this.disposed) throw new Error('KCoder 远程浏览器运行时已关闭')
    const existing = this.browserByLabel.get(label)
    if (existing) return this.browserPageResult(existing)
    const opening = this.browserOpeningByLabel.get(label)
    if (opening) return opening
    if (this.browserByLabel.size + this.browserOpeningByLabel.size >= MAX_REMOTE_BROWSER_SESSIONS) {
      throw new Error(`远程浏览器最多同时打开 ${MAX_REMOTE_BROWSER_SESSIONS} 个会话`)
    }

    // Reservation must occur before the first await; otherwise concurrent calls can bypass label deduplication and the global capacity limit.
    const reservation = this.createBrowser(label, url, params)
    this.browserOpeningByLabel.set(label, reservation)
    try {
      return await reservation
    } finally {
      if (this.browserOpeningByLabel.get(label) === reservation) {
        this.browserOpeningByLabel.delete(label)
      }
    }
  }

  private async createBrowser(
    label: string,
    url: string,
    params: Record<string, unknown>
  ): Promise<ReturnType<GatewayBrowserRuntime['browserPageResult']>> {
    const server = await this.resolveServerForLabel(label)
    const client = await this.connectBrowserClient(server)
    let state: GatewayBrowserState | null = null
    try {
      await assertRemoteBrowserAvailable(client)
      const bounds = browserBounds(params.bounds)
      const result = await client.request<{
        session_id?: string
        url?: string
        width?: number
        height?: number
        sandbox_disabled?: boolean
      }>('browser/start', {
        url,
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      })
      const wireSessionId = text(result.session_id)
      if (!wireSessionId) throw new Error('KCoder app-server 未返回浏览器 session id')
      if (this.disposed) throw new Error('KCoder 远程浏览器运行时已关闭')
      const createdState: GatewayBrowserState = {
        label,
        nativeLabel: `gateway-browser:${encodeURIComponent(server.id)}:${wireSessionId}`,
        serverId: server.id,
        wireSessionId,
        client,
        surface: null as unknown as HTMLImageElement,
        page: { url: text(result.url) ?? url, title: null, faviconUrl: null },
        bounds,
        viewportWidth:
          typeof result.width === 'number'
            ? result.width
            : Math.max(320, Math.min(1920, Math.round(bounds.width))),
        viewportHeight:
          typeof result.height === 'number'
            ? result.height
            : Math.max(240, Math.min(1080, Math.round(bounds.height))),
        visible: true,
        connected: true,
        closed: false,
        frameInFlight: false,
        frameQueued: false,
        frameTimer: null,
        lastPointerMoveAt: 0,
        inputQueue: [],
        inputProcessing: false,
      }
      state = createdState
      createdState.surface = this.createBrowserSurface(createdState)
      client.addEventListener('close', () => {
        if (createdState.closed) return
        createdState.connected = false
        if (createdState.frameTimer !== null) window.clearTimeout(createdState.frameTimer)
        for (const entry of createdState.inputQueue.splice(0)) {
          for (const waiter of entry.waiters) {
            waiter.reject(new Error('KCoder 远程浏览器连接已断开'))
          }
        }
        createdState.surface.dataset.connection = 'disconnected'
        createdState.surface.dataset.frameError = 'KCoder app-server 连接已断开'
        createdState.surface.removeAttribute('src')
        createdState.surface.alt = 'Remote browser disconnected'
        createdState.surface.style.pointerEvents = 'none'
      })
      this.browserByLabel.set(label, createdState)
      document.body.appendChild(createdState.surface)
      this.applyBrowserBounds(createdState, bounds, true)
      this.queueBrowserFrame(createdState, true)
      return this.browserPageResult(createdState)
    } catch (error) {
      if (state) {
        if (this.browserByLabel.get(label) === state) this.browserByLabel.delete(label)
        state.closed = true
        state.connected = false
        if (state.frameTimer !== null) window.clearTimeout(state.frameTimer)
        state.surface?.remove()
      }
      client.close()
      throw error
    }
  }

  async setBrowserBounds(rawParams: unknown) {
    const params = record(rawParams)
    const label = text(params.label) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    const bounds = browserBounds(params.bounds)
    const resized =
      Math.round(bounds.width) !== Math.round(state.bounds.width) ||
      Math.round(bounds.height) !== Math.round(state.bounds.height)
    this.applyBrowserBounds(state, bounds, params.visible === true)
    if (resized) {
      await this.queueBrowserInput(state, {
        action: 'resize',
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      })
      state.viewportWidth = Math.max(320, Math.min(1920, Math.round(bounds.width)))
      state.viewportHeight = Math.max(240, Math.min(1080, Math.round(bounds.height)))
    }
    this.queueBrowserFrame(state, true)
  }

  async controlBrowser(labelValue: unknown, action: Record<string, unknown>) {
    const label = text(labelValue) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    const navigating = ['navigate', 'reload', 'back', 'forward'].includes(String(action.action))
    if (navigating) state.surface.style.pointerEvents = 'none'
    try {
      await this.queueBrowserInput(state, action)
    } finally {
      if (navigating && state.connected && state.visible) state.surface.style.pointerEvents = 'auto'
    }
  }

  async evaluateBrowser(rawParams: unknown) {
    const params = record(rawParams)
    const label = text(params.label) ?? 'workspace-browser'
    const expression = text(params.expression) ?? text(params.script)
    if (!expression) throw new Error('浏览器脚本为空')
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    const result = await state.client.request<{ value?: unknown }>('browser/evaluate', {
      session_id: state.wireSessionId,
      expression,
    })
    this.queueBrowserFrame(state, true)
    return { ok: true, value: result.value }
  }

  readBrowserPageState(labelValue: unknown) {
    const label = text(labelValue) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    if (!state.connected) throw new Error('KCoder 远程浏览器连接已断开')
    return this.browserPageResult(state)
  }

  async relabelBrowser(fromValue: unknown, toValue: unknown) {
    const fromLabel = text(fromValue)
    const toLabel = text(toValue) ?? 'workspace-browser'
    if (!fromLabel || fromLabel === toLabel) return
    const state = this.browserByLabel.get(fromLabel)
    if (!state) return
    if (this.browserByLabel.has(toLabel)) await this.closeBrowser(toLabel)
    this.browserByLabel.delete(fromLabel)
    state.label = toLabel
    state.surface.dataset.browserLabel = toLabel
    this.browserByLabel.set(toLabel, state)
  }

  async closeBrowser(labelValue: unknown) {
    const label = text(labelValue) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) return
    this.browserByLabel.delete(label)
    const shouldNotifyServer = state.connected
    state.closed = true
    state.connected = false
    if (state.frameTimer !== null) window.clearTimeout(state.frameTimer)
    for (const entry of state.inputQueue.splice(0)) {
      for (const waiter of entry.waiters) waiter.reject(new Error('KCoder 远程浏览器已关闭'))
    }
    state.surface.remove()
    try {
      if (shouldNotifyServer) {
        await state.client.request('browser/close', { session_id: state.wireSessionId })
      }
    } finally {
      state.client.close()
    }
  }

  async clearBrowserData() {
    const labels = [...this.browserByLabel.keys()]
    await Promise.all(labels.map(label => this.closeBrowser(label)))
    return labels.length
  }

  async invalidateTarget(targetId: string): Promise<void> {
    await Promise.allSettled([...this.browserByLabel].filter(([, state]) => state.serverId === targetId)
      .map(([label, state]) => {
        state.surface.removeAttribute('src')
        return this.closeBrowser(label)
      }))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.browserOpeningByLabel.values()])
    await Promise.allSettled([...this.browserByLabel.keys()].map(label => this.closeBrowser(label)))
  }
}
