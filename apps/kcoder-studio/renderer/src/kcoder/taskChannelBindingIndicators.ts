import { channelInventory, type ChannelInventory } from './channels'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'
import { listenChannelBindingChanges } from './channelBindingEvents'

export interface TaskChannelIndicator {
  platform: string
  connectionId: string
  connectionLabel: string
  chatId: string
  topicId: string | null
  bindingId: string
  revision: string
}
type Target = { serverId: string; workspacePath: string }
type Row = { value: TaskChannelIndicator | null; listeners: Set<() => void> }

/** A binding is a Gateway route to one exact target/workspace/task, independent of SDK identity. */
export function taskChannelIndicators(page: ChannelInventory, target: Target, threads: readonly string[]) {
  const result = new Map<string, TaskChannelIndicator>()
  const wanted = new Set(threads)
  const connections = new Map(page.connections.map(connection => [connection.id, connection]))
  for (const chat of page.chats) {
    const binding = chat.binding
    if (!binding || binding.target.serverId !== target.serverId || binding.target.workspacePath !== target.workspacePath
      || !wanted.has(binding.target.threadId) || result.has(binding.target.threadId)) continue
    const connection = connections.get(chat.connectionId)
    if (!connection || connection.platform !== chat.range.platform) throw new Error('CHANNEL_INVENTORY_INVALID')
    result.set(binding.target.threadId, { platform: chat.range.platform, connectionId: connection.id,
      connectionLabel: connection.label, chatId: chat.range.chatId, topicId: chat.range.topicId,
      bindingId: chat.id, revision: String(binding.revision) })
  }
  return result
}

const entries = new Map<string, IndicatorSource>()
function key(target: Target) {
  return JSON.stringify([target.serverId, target.workspacePath])
}

/** One cancellable, memory-only observation per mounted target/workspace, shared by all rows. */
class IndicatorSource {
  readonly rows = new Map<string, Row>()
  private lifetime = new AbortController()
  private scheduled?: ReturnType<typeof setTimeout>
  private timer: ReturnType<typeof setInterval>
  private reading = false
  private again = false
  private readonly stops: (() => void)[]
  private readonly target: Target
  constructor(target: Target) {
    this.target = target
    const poll = () => {
      if (document.visibilityState !== 'hidden') this.schedule(false)
    }
    const configuration = (event: Event) => {
      const id = (event as CustomEvent<{ targetId?: string }>).detail?.targetId
      if (!id || id === target.serverId) this.invalidate()
    }
    document.addEventListener('visibilitychange', poll)
    window.addEventListener('focus', poll)
    window.addEventListener('kcoder:servers-changed', configuration)
    this.timer = setInterval(poll, 15000)
    this.stops = [
      listenAccountContextChanges(id => {
        if (id === target.serverId) this.invalidate()
      }),
      listenChannelBindingChanges(() => this.schedule()),
      () => document.removeEventListener('visibilitychange', poll),
      () => window.removeEventListener('focus', poll),
      () => window.removeEventListener('kcoder:servers-changed', configuration),
    ]
  }
  private publish(values: Map<string, TaskChannelIndicator>) {
    for (const [id, row] of this.rows) {
      const next = values.get(id) ?? null
      if (JSON.stringify(row.value) === JSON.stringify(next)) continue
      row.value = next
      for (const listener of row.listeners) listener()
    }
  }
  private invalidate() {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.publish(new Map())
    this.schedule()
  }
  schedule(refreshAfterRead = true) {
    if (this.reading) {
      if (refreshAfterRead) this.again = true
      return
    }
    if (this.scheduled !== undefined) return
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined
      void this.read()
    }, 0)
  }
  private async read() {
    if (!this.rows.size || this.reading) return
    this.reading = true
    const lifetime = this.lifetime,
      account = captureAccountContextRevision()
    const current = () => !lifetime.signal.aborted && account(this.target.serverId)
    try {
      const page = await channelInventory(lifetime.signal)
      if (!current()) return
      const values = taskChannelIndicators(page, this.target, [...this.rows.keys()])
      if (current()) this.publish(values)
    } catch {
      // An unavailable source cannot keep presenting a previously observed binding as current.
      if (current()) this.publish(new Map())
    } finally {
      this.reading = false
      if (this.again && this.rows.size) {
        this.again = false
        this.schedule()
      }
    }
  }
  stop() {
    this.lifetime.abort()
    clearTimeout(this.scheduled)
    clearInterval(this.timer)
    for (const stop of this.stops) stop()
  }
}

export function subscribeTaskChannelIndicator(
  target: Target,
  thread: string,
  listener: () => void
) {
  const identity = key(target)
  let source = entries.get(identity)
  if (!source) {
    source = new IndicatorSource(target)
    entries.set(identity, source)
  }
  let row = source.rows.get(thread)
  if (!row) {
    row = { value: null, listeners: new Set() }
    source.rows.set(thread, row)
  }
  row.listeners.add(listener)
  source.schedule()
  return () => {
    row.listeners.delete(listener)
    if (!row.listeners.size) source.rows.delete(thread)
    if (!source.rows.size) {
      source.stop()
      if (entries.get(identity) === source) entries.delete(identity)
    }
  }
}

export function readTaskChannelIndicator(
  target: Target,
  thread: string
): TaskChannelIndicator | null {
  return entries.get(key(target))?.rows.get(thread)?.value ?? null
}
