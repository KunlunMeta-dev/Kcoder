// This store is deliberately independent of transcript reducers and persistence.
interface Preview {
  id: string
  path: string
}

interface InputProgress {
  id: string
  name: string
  chars: number
}

interface Scope {
  owner: ToolPathPreviewConsumer
  client: object
  retiredClients: WeakSet<object>
  target: string
  task: string
  thread: string
  instance: string
  retiredInstances: Set<string>
  turn: string
  started: boolean
  retiredTurns: Set<string>
  sequence: number
  active: boolean
  suppressed: boolean
  attempt: string | null
  attempts: Set<string>
  entries: Map<string, Preview>
  inputs: Map<string, InputProgress>
  startedTools: Set<string>
  inputSuppressed: boolean
}

const MAX_SCOPES = 128
const MAX_ITEMS = 64
const scopes = new Set<Scope>()
const listeners = new Set<() => void>()
const leases = new Map<string, number>()
let revision = 0
const encoder = new TextEncoder()
const key = (target: string, task: string) => JSON.stringify([target, task])
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  encoder.encode(value).length <= 1024
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

function publish() {
  revision++
  for (const listener of listeners) {
    // A presentation failure must never abort engine event projection.
    try {
      listener()
    } catch {
      /* Isolate subscriber failures. */
    }
  }
}

export const toolPathPreviews = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  snapshot: () => revision,
  read(target?: string, task?: string): Preview[] {
    if (!target || !task) return []
    return [...scopes]
      .filter(scope => scope.target === target && scope.task === task)
      .flatMap(scope => [...scope.entries.values()])
  },
  readInputs(target?: string, task?: string): InputProgress[] {
    if (!target || !task) return []
    return [...scopes].filter(scope => scope.target === target && scope.task === task)
      .flatMap(scope => [...scope.inputs.values()])
  },
  acquire(target: string, task: string) {
    const address = key(target, task)
    leases.set(address, (leases.get(address) ?? 0) + 1)
    for (const scope of scopes) {
      if (scope.target === target && scope.task === task) scope.suppressed = false
    }
    return () => {
      const remaining = (leases.get(address) ?? 1) - 1
      if (remaining > 0) {
        leases.set(address, remaining)
        return
      }
      leases.delete(address)
      for (const scope of scopes) {
        if (scope.target !== target || scope.task !== task) continue
        scope.suppressed = true
        scope.entries.clear()
        scope.inputs.clear()
      }
      publish()
    }
  },
}

export class ToolPathPreviewConsumer {
  private disposed = false
  private readonly disconnected = new WeakSet<object>()

  handle(
    method: string,
    params: Record<string, unknown>,
    target: string,
    task: string,
    client: object
  ) {
    if (this.disposed || this.disconnected.has(client)) return
    if (method === 'server/disconnected') {
      this.disconnect(client)
      return
    }
    const event = object(params.event)
    const isPreview = method === 'item/event' && event.type === 'tool_path_preview'
    const isInput = method === 'item/event' && event.type === 'tool_input_progress'
    const isInputReset = method === 'item/event' && (event.type === 'tool_input_reset' ||
      (event.type === 'system_notice' && event.kind === 'provider_retry'))
    const item = object(params.item)
    const isToolTransition = (method === 'item/started' || method === 'item/completed') && item.type === 'toolCall'
    if (!isPreview && !isInput && !isInputReset && !isToolTransition && method !== 'turn/started' && method !== 'turn/completed') return
    const thread = params.threadId ?? object(params.thread).id
    const turn = params.turnId ?? object(params.turn).id
    const instance = params.serverId
    const sequence = params.sequence
    if (
      ![target, task, thread, turn, instance].every(validId) ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      return
    // Validation above narrows the wire fields together, not individually.
    const threadId = thread as string
    const turnId = turn as string
    const instanceId = instance as string
    let scope = [...scopes].find(
      item => item.owner === this && item.target === target && item.task === task
    )
    if (!scope) {
      if (method !== 'turn/started') return
      if (scopes.size >= MAX_SCOPES) {
        const inactive = [...scopes].find(item => !item.active)
        if (!inactive) return
        scopes.delete(inactive)
      }
      scope = {
        owner: this,
        client,
        retiredClients: new WeakSet(),
        target,
        task,
        thread: threadId,
        instance: instanceId,
        retiredInstances: new Set(),
        turn: turnId,
        started: false,
        retiredTurns: new Set(),
        sequence: -1,
        active: false,
        suppressed: !leases.has(key(target, task)),
        attempt: null,
        attempts: new Set(),
        entries: new Map(),
        inputs: new Map(),
        startedTools: new Set(),
        inputSuppressed: false,
      }
      scopes.add(scope)
    }
    if (scope.retiredClients.has(client)) return
    if (scope.client !== client && method !== 'turn/started') return
    if (scope.instance !== instanceId) {
      if (method !== 'turn/started' || scope.retiredInstances.has(instanceId)) return
    } else if (sequence <= scope.sequence) return
    if (scope.thread !== threadId) return
    if (
      method === 'turn/started' &&
      scope.instance === instanceId &&
      ((scope.started && scope.turn === turnId) || scope.retiredTurns.has(turnId))
    )
      return
    if (scope.client !== client) {
      scope.retiredClients.add(scope.client)
      scope.client = client
    }
    if (scope.instance !== instanceId) {
      scope.retiredInstances.add(scope.instance)
      if (scope.retiredInstances.size > MAX_ITEMS)
        scope.retiredInstances.delete(scope.retiredInstances.values().next().value!)
      scope.instance = instanceId
      scope.started = false
      scope.retiredTurns.clear()
    }
    scope.sequence = sequence
    if (method === 'turn/started') {
      // Tombstones prevent terminal or recently superseded turns from reopening.
      if (scope.started) scope.retiredTurns.add(scope.turn)
      if (scope.retiredTurns.size > MAX_ITEMS)
        scope.retiredTurns.delete(scope.retiredTurns.values().next().value!)
      scope.started = true
      scope.turn = turnId
      scope.active = true
      scope.attempt = null
      scope.attempts.clear()
      scope.entries.clear()
      scope.inputs.clear()
      scope.startedTools.clear()
      scope.inputSuppressed = false
      publish()
      return
    }
    if (scope.turn !== turnId || !scope.active) return
    if (method === 'turn/completed') {
      scope.active = false
      scope.entries.clear()
      scope.inputs.clear()
      publish()
      return
    }
    if (isInputReset) {
      scope.inputs.clear()
      scope.startedTools.clear()
      scope.inputSuppressed = false
      publish()
      return
    }
    if (isToolTransition) {
      if (!validId(item.id)) return
      if (!scope.startedTools.has(item.id) && scope.startedTools.size >= MAX_ITEMS) {
        scope.inputSuppressed = true
        scope.inputs.clear()
        publish()
        return
      }
      scope.startedTools.add(item.id)
      if (scope.inputs.delete(item.id)) publish()
      return
    }
    if (scope.suppressed) return
    if (isInput) {
      if (!validId(event.id) || !validId(event.name) || event.name.length > 256 ||
          typeof event.chars !== 'number' || !Number.isSafeInteger(event.chars) || event.chars < 0 ||
          scope.startedTools.has(event.id) || scope.inputSuppressed) return
      if (!scope.inputs.has(event.id) && scope.inputs.size >= MAX_ITEMS) return
      const previous = scope.inputs.get(event.id)
      if (previous && event.chars < previous.chars) return
      scope.inputs.set(event.id, { id: event.id, name: event.name.replace(/[\u0000-\u001f\u007f]/g, ''), chars: event.chars })
      publish()
      return
    }
    if (!validId(event.attempt_id) || !validId(event.id)) return
    if (event.path === null) {
      if (scope.attempt === event.attempt_id && scope.entries.delete(event.id)) publish()
      return
    }
    if (
      typeof event.path !== 'string' ||
      event.path.length === 0 ||
      event.path.length > 4096 ||
      encoder.encode(event.path).length > 4096
    )
      return
    if (scope.attempt !== event.attempt_id) {
      if (scope.attempts.has(event.attempt_id)) return
      scope.attempts.add(event.attempt_id)
      if (scope.attempts.size > MAX_ITEMS)
        scope.attempts.delete(scope.attempts.values().next().value!)
      scope.attempt = event.attempt_id
      scope.entries.clear()
    }
    if (!scope.entries.has(event.id) && scope.entries.size >= MAX_ITEMS) return
    const path = event.path.replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
    scope.entries.set(event.id, {
      id: event.id,
      path: path.length > 2048 ? `${path.slice(0, 2047)}…` : path,
    })
    publish()
  }

  disconnect(client: object) {
    this.disconnected.add(client)
    for (const scope of scopes) {
      if (scope.owner !== this || scope.client !== client) continue
      scope.active = false
      scope.entries.clear()
      scope.inputs.clear()
    }
    publish()
  }

  clearTask(task: string) {
    for (const scope of scopes) {
      if (scope.owner !== this || scope.task !== task) continue
      scope.active = false
      scope.suppressed = true
      scope.entries.clear()
      scope.inputs.clear()
    }
    publish()
  }

  dispose() {
    this.disposed = true
    for (const scope of scopes) if (scope.owner === this) scopes.delete(scope)
    publish()
  }
}
