// This store is deliberately independent of transcript reducers and persistence.
interface Preview {
  id: string
  path: string
}

interface InputProgress {
  id: string
  name: string
  chars: number
  lines?: { generatedLines: number; replacedLines?: number }
}

export interface ProviderRetryActivity {
  /** Provider retry ordinal, distinct from the opaque turn attempt ID. */
  attempt: number
  maxRetries: number
  retryAfterMs: number
  receivedAtMs: number
}

interface WorkspaceFileProgress {
  additions: number
  deletions: number
  files: number
  binaryFiles: number
  partial: boolean
}

export interface ToolLineProgress {
  generated?: NonNullable<InputProgress['lines']>
  observed?: WorkspaceFileProgress
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
  turnAttemptId: string | null
  retiredTurnAttempts: Set<string>
  providerRetry: ProviderRetryActivity | null
  attempt: string | null
  attempts: Set<string>
  entries: Map<string, Preview>
  inputs: Map<string, InputProgress>
  toolLines: Map<string, ToolLineProgress>
  completedTools: Set<string>
  activeTools: Set<string>
  files: WorkspaceFileProgress | null
  startedTools: Set<string>
  /** Calls beyond the concurrent identity budget suppress inputs until settled. */
  overflowActiveTools: number
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

function validLineProgress(value: unknown): InputProgress['lines'] | undefined {
  const data = object(value)
  const generated = data.generatedLines
  const replaced = data.replacedLines
  if (typeof generated !== 'number' || !Number.isSafeInteger(generated) || generated < 0)
    return undefined
  if (
    replaced !== undefined &&
    (typeof replaced !== 'number' || !Number.isSafeInteger(replaced) || replaced < 0)
  )
    return undefined
  return {
    generatedLines: generated,
    ...(typeof replaced === 'number' ? { replacedLines: replaced } : {}),
  }
}

function validFileProgress(value: unknown): WorkspaceFileProgress | null {
  const counts = object(value)
  if (
    ![counts.additions, counts.deletions, counts.files, counts.binaryFiles ?? 0].every(
      item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
    )
  )
    return null
  return {
    additions: counts.additions as number,
    deletions: counts.deletions as number,
    files: counts.files as number,
    binaryFiles: (counts.binaryFiles as number | undefined) ?? 0,
    partial: counts.partial === true,
  }
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 0x1f || code === 0x7f
}

function escapePathCharacter(character: string): string {
  const code = character.charCodeAt(0)
  const unsafe =
    isControlCharacter(character) ||
    (code >= 0x80 && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  return unsafe ? `\\u${code.toString(16).padStart(4, '0')}` : character
}

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

function retainToolLines(scope: Scope, id: string, progress: ToolLineProgress): boolean {
  if (!scope.toolLines.has(id) && scope.toolLines.size >= MAX_ITEMS) {
    const completed = [...scope.toolLines.keys()].find(item => !scope.activeTools.has(item))
    if (!completed) return false
    scope.toolLines.delete(completed)
  }
  scope.toolLines.set(id, progress)
  return true
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
    return [...scopes]
      .filter(scope => scope.target === target && scope.task === task)
      .flatMap(scope => [...scope.inputs.values()])
  },
  readFiles(target?: string, task?: string): WorkspaceFileProgress | null {
    if (!target || !task) return null
    return (
      [...scopes].find(
        scope =>
          scope.target === target &&
          scope.task === task &&
          scope.active &&
          !scope.suppressed &&
          scope.files
      )?.files ?? null
    )
  },
  readToolLines(target?: string, task?: string, id?: string): ToolLineProgress | null {
    if (!target || !task || !id) return null
    for (const scope of scopes) {
      if (scope.target !== target || scope.task !== task || !scope.active || scope.suppressed)
        continue
      const progress = scope.toolLines.get(id)
      if (progress) return progress
      const generated = scope.inputs.get(id)?.lines
      if (generated) return { generated }
    }
    return null
  },
  readProviderRetry(target?: string, task?: string): ProviderRetryActivity | null {
    if (!target || !task) return null
    const scope = [...scopes].find(
      item => item.target === target && item.task === task && item.active && item.providerRetry
    )
    return scope?.providerRetry ?? null
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
        scope.toolLines.clear()
        // Presentation release drops counters, not the bounded live-call fences.
        // Only a completion may make an executing ID eligible for eviction.
        scope.files = null
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
    client: object,
    currentAttemptId?: string | null,
    allowToolPathPreview = true
  ) {
    if (this.disposed || this.disconnected.has(client)) return
    if (method === 'server/disconnected') {
      this.disconnect(client)
      return
    }
    const event = object(params.event)
    const deltaText = object(params.delta).text
    const isPreview =
      allowToolPathPreview && method === 'item/event' && event.type === 'tool_path_preview'
    const isInput =
      allowToolPathPreview && method === 'item/event' && event.type === 'tool_input_progress'
    const isFiles = method === 'item/event' && event.type === 'workspace_file_progress'
    const isToolFiles = method === 'item/event' && event.type === 'tool_file_progress'
    const isInputReset =
      method === 'item/event' &&
      (event.type === 'tool_input_reset' ||
        (event.type === 'system_notice' && event.kind === 'provider_retry'))
    const isProviderRetry =
      method === 'item/event' && event.type === 'system_notice' && event.kind === 'provider_retry'
    const isResponseRecovery =
      (method === 'item/delta' && typeof deltaText === 'string' && deltaText.length > 0) ||
      (method === 'item/event' &&
        (event.type === 'assistant_thinking_delta' || event.type === 'tool_input_progress'))
    const item = object(params.item)
    const isToolTransition =
      (method === 'item/started' || method === 'item/completed') && item.type === 'toolCall'
    const isTerminal = ['turn/completed', 'turn/failed', 'turn/cancelled'].includes(method)
    const isProviderError = method === 'item/event' && event.type === 'error'
    if (
      !isPreview &&
      !isInput &&
      !isFiles &&
      !isToolFiles &&
      !isInputReset &&
      !isProviderRetry &&
      !isResponseRecovery &&
      !isProviderError &&
      !isToolTransition &&
      method !== 'turn/started' &&
      !isTerminal
    )
      return
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
    const turnAttemptId =
      (typeof params.attemptId === 'string' && validId(params.attemptId)
        ? params.attemptId
        : null) ??
      (typeof object(params.turn).attemptId === 'string' && validId(object(params.turn).attemptId)
        ? (object(params.turn).attemptId as string)
        : null) ??
      currentAttemptId ??
      null
    const wireAttemptId =
      (typeof params.attemptId === 'string' && validId(params.attemptId)
        ? params.attemptId
        : null) ??
      (typeof object(params.turn).attemptId === 'string' && validId(object(params.turn).attemptId)
        ? (object(params.turn).attemptId as string)
        : null)
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
        turnAttemptId: null,
        retiredTurnAttempts: new Set(),
        providerRetry: null,
        attempt: null,
        attempts: new Set(),
        entries: new Map(),
        inputs: new Map(),
        toolLines: new Map(),
        completedTools: new Set(),
        activeTools: new Set(),
        files: null,
        startedTools: new Set(),
        overflowActiveTools: 0,
      }
      scopes.add(scope)
    }
    if (scope.retiredClients.has(client)) return
    if (scope.client !== client && method !== 'turn/started') return
    if (scope.instance !== instanceId) {
      if (method !== 'turn/started' || scope.retiredInstances.has(instanceId)) return
    } else if (sequence <= scope.sequence) return
    if (scope.thread !== threadId) return
    const isNewAttemptForSameTurn =
      method === 'turn/started' &&
      scope.turn === turnId &&
      Boolean(turnAttemptId && turnAttemptId !== scope.turnAttemptId) &&
      !scope.retiredTurnAttempts.has(turnAttemptId!)
    if (
      method === 'turn/started' &&
      scope.instance === instanceId &&
      ((scope.started && scope.turn === turnId && !isNewAttemptForSameTurn) ||
        (scope.retiredTurns.has(turnId) && !isNewAttemptForSameTurn))
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
      scope.retiredTurnAttempts.clear()
    }
    if (
      method !== 'turn/started' &&
      scope.turnAttemptId &&
      ((currentAttemptId && currentAttemptId !== scope.turnAttemptId) ||
        (wireAttemptId && wireAttemptId !== scope.turnAttemptId))
    )
      return
    scope.sequence = sequence
    if (method === 'turn/started') {
      // Tombstones prevent terminal or recently superseded turns from reopening.
      const sameTurn = scope.turn === turnId
      const previousAttemptId = scope.turnAttemptId
      if (scope.started && !sameTurn) scope.retiredTurns.add(scope.turn)
      else if (previousAttemptId && previousAttemptId !== turnAttemptId) {
        scope.retiredTurnAttempts.add(previousAttemptId)
      }
      if (scope.retiredTurns.size > MAX_ITEMS)
        scope.retiredTurns.delete(scope.retiredTurns.values().next().value!)
      if (scope.retiredTurnAttempts.size > MAX_ITEMS)
        scope.retiredTurnAttempts.delete(scope.retiredTurnAttempts.values().next().value!)
      scope.started = true
      scope.turn = turnId
      scope.active = true
      scope.turnAttemptId = turnAttemptId
      scope.providerRetry = null
      scope.attempt = null
      scope.attempts.clear()
      scope.entries.clear()
      scope.inputs.clear()
      scope.toolLines.clear()
      scope.completedTools.clear()
      scope.activeTools.clear()
      scope.startedTools.clear()
      scope.overflowActiveTools = 0
      scope.files = null
      publish()
      return
    }
    if (scope.turn !== turnId || !scope.active) return
    if (isTerminal) {
      scope.active = false
      scope.files = null
      scope.providerRetry = null
      scope.entries.clear()
      scope.inputs.clear()
      scope.toolLines.clear()
      scope.completedTools.clear()
      scope.activeTools.clear()
      publish()
      return
    }
    if (isProviderRetry) {
      const hadInputState =
        scope.inputs.size > 0 || scope.startedTools.size > 0 || scope.overflowActiveTools > 0
      scope.inputs.clear()
      scope.toolLines.clear()
      scope.completedTools.clear()
      scope.activeTools.clear()
      scope.startedTools.clear()
      scope.overflowActiveTools = 0
      const isBackgroundScopedRetry = Object.keys(object(params.identity)).length > 0
      const requestKind = event.request_kind
      const attempt = event.attempt
      const maxRetries = event.max_retries
      const retryAfterMs = event.retry_after_ms
      if (
        requestKind !== 'main' ||
        isBackgroundScopedRetry ||
        typeof attempt !== 'number' ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        typeof maxRetries !== 'number' ||
        !Number.isSafeInteger(maxRetries) ||
        maxRetries < attempt ||
        typeof retryAfterMs !== 'number' ||
        !Number.isSafeInteger(retryAfterMs) ||
        retryAfterMs < 0 ||
        retryAfterMs > 86_400_000
      ) {
        if (hadInputState) publish()
        return
      }
      if (scope.providerRetry && attempt <= scope.providerRetry.attempt) {
        if (hadInputState) publish()
        return
      }
      scope.providerRetry = { attempt, maxRetries, retryAfterMs, receivedAtMs: Date.now() }
      publish()
      return
    }
    if (isProviderError || isResponseRecovery || isToolTransition) {
      if (scope.providerRetry) {
        scope.providerRetry = null
        publish()
      }
    }
    if (isInputReset) {
      scope.inputs.clear()
      scope.toolLines.clear()
      scope.completedTools.clear()
      scope.activeTools.clear()
      scope.startedTools.clear()
      scope.overflowActiveTools = 0
      publish()
      return
    }
    if (isToolTransition) {
      if (!validId(item.id)) return
      const generated = scope.inputs.get(item.id)?.lines
      if (method === 'item/completed') {
        if (scope.completedTools.has(item.id)) return
        const tracked = scope.activeTools.delete(item.id) || scope.startedTools.has(item.id)
        if (!tracked && scope.overflowActiveTools > 0) scope.overflowActiveTools--
        scope.completedTools.add(item.id)
        if (scope.completedTools.size > MAX_ITEMS)
          scope.completedTools.delete(scope.completedTools.values().next().value!)
        // Generated content is not a receipt for writes that may have failed.
        const observed = scope.toolLines.get(item.id)?.observed
        if (observed) scope.toolLines.set(item.id, { observed })
        else scope.toolLines.delete(item.id)
      } else {
        if (scope.completedTools.has(item.id)) return
        if (!scope.startedTools.has(item.id) && scope.startedTools.size >= MAX_ITEMS) {
          // Never evict an executing identity. Recent settled IDs can expire:
          // sequence and turn/attempt fences still reject replayed old frames.
          const completed = [...scope.startedTools].find(id => !scope.activeTools.has(id))
          if (completed) scope.startedTools.delete(completed)
          else {
            // This is a concurrent-capacity limit, never a lifetime call limit.
            scope.overflowActiveTools = Math.min(
              Number.MAX_SAFE_INTEGER,
              scope.overflowActiveTools + 1
            )
            scope.inputs.clear()
            publish()
            return
          }
        }
        scope.startedTools.add(item.id)
        scope.activeTools.add(item.id)
        if (generated) retainToolLines(scope, item.id, { generated })
      }
      scope.inputs.delete(item.id)
      publish()
      return
    }
    if (scope.suppressed) return
    if (isFiles || isToolFiles) {
      const counts = validFileProgress(event.counts)
      if (!counts) return
      if (isToolFiles) {
        if (!validId(event.id) || !scope.activeTools.has(event.id)) return
        if (
          !retainToolLines(scope, event.id, { ...scope.toolLines.get(event.id), observed: counts })
        )
          return
      } else scope.files = counts
      publish()
      return
    }
    if (isInput) {
      if (
        !validId(event.id) ||
        !validId(event.name) ||
        event.name.length > 256 ||
        typeof event.chars !== 'number' ||
        !Number.isSafeInteger(event.chars) ||
        event.chars < 0 ||
        scope.startedTools.has(event.id) ||
        scope.completedTools.has(event.id) ||
        scope.overflowActiveTools > 0
      )
        return
      if (!scope.inputs.has(event.id) && scope.inputs.size >= MAX_ITEMS) return
      const previous = scope.inputs.get(event.id)
      if (previous && event.chars < previous.chars) return
      const lines = validLineProgress(event.lines)
      scope.inputs.set(event.id, {
        id: event.id,
        name: Array.from(event.name)
          .filter(character => !isControlCharacter(character))
          .join(''),
        chars: event.chars,
        ...(lines ? { lines } : {}),
      })
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
    const path = Array.from(event.path).map(escapePathCharacter).join('')
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
      scope.files = null
      scope.providerRetry = null
      scope.entries.clear()
      scope.inputs.clear()
      scope.toolLines.clear()
      scope.completedTools.clear()
      scope.activeTools.clear()
    }
    publish()
  }

  clearTask(task: string) {
    for (const scope of scopes) {
      if (scope.owner !== this || scope.task !== task) continue
      scope.active = false
      scope.files = null
      scope.suppressed = true
      scope.providerRetry = null
      scope.entries.clear()
      scope.inputs.clear()
      scope.toolLines.clear()
      scope.completedTools.clear()
      scope.activeTools.clear()
    }
    publish()
  }

  dispose() {
    this.disposed = true
    for (const scope of scopes) if (scope.owner === this) scopes.delete(scope)
    publish()
  }
}
