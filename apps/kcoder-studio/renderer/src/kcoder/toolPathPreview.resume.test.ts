import { afterEach, expect, test } from 'vitest'
import { ToolPathPreviewConsumer, toolPathPreviews } from './toolPathPreview'

const owners: Array<() => void> = []
afterEach(() =>
  owners
    .splice(0)
    .reverse()
    .forEach(close => close())
)
function setup(leased = true) {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  owners.push(() => consumer.dispose())
  if (leased) owners.push(toolPathPreviews.acquire('resume-target', 'resume-task'))
  const boundary = (throughSequence = 10, extra = {}) => ({
    serverId: 'instance',
    throughSequence,
    activeTurn: { id: 'turn', threadId: 'thread', status: 'running', attemptId: 'attempt' },
    ...extra,
  })
  const seed = (value: unknown, source = client) =>
    consumer.seedResume(value, 'resume-target', 'resume-task', 'thread', source)
  const send = (method: string, sequence: number, extra = {}, source = client) =>
    consumer.handle(
      method,
      {
        serverId: 'instance',
        threadId: 'thread',
        turnId: 'turn',
        attemptId: 'attempt',
        sequence,
        ...extra,
      },
      'resume-target',
      'resume-task',
      source
    )
  const input = (sequence: number, source = client, extra = {}) =>
    send(
      'item/event',
      sequence,
      {
        event: {
          type: 'tool_input_progress',
          id: 'write',
          name: 'write',
          chars: 16,
          lines: { generatedLines: 2 },
        },
        ...extra,
      },
      source
    )
  const inputs = () => toolPathPreviews.readInputs('resume-target', 'resume-task')
  return { consumer, client, boundary, seed, send, input, inputs }
}

test('late attachment needs an authoritative boundary and drops all through-watermark frames', () => {
  const f = setup()
  f.input(9)
  expect(f.inputs()).toEqual([])
  expect(f.seed(f.boundary())).toBe(true)
  f.input(10)
  expect(f.inputs()).toEqual([])
  f.input(11)
  expect(f.inputs()[0].lines?.generatedLines).toBe(2)
})

test('restoring UI keeps bounded input counters before mount and release still suppresses later input', () => {
  const f = setup(false)
  expect(f.seed(f.boundary())).toBe(true)
  f.input(11)
  expect(f.inputs()).toHaveLength(1)
  expect(toolPathPreviews.readToolLines('resume-target', 'resume-task', 'write')).toBeNull()
  f.send('item/event', 12, {
    event: { type: 'tool_path_preview', id: 'write', attempt_id: 'provider', path: 'private.txt' },
  })
  expect(toolPathPreviews.read('resume-target', 'resume-task')).toEqual([])
  const close = toolPathPreviews.acquire('resume-target', 'resume-task')
  expect(
    toolPathPreviews.readToolLines('resume-target', 'resume-task', 'write')?.generated
      ?.generatedLines
  ).toBe(2)
  close()
  f.input(13)
  expect(f.inputs()).toEqual([])
})

test('malformed, missing, wrong-thread and terminal identities never establish live scope', () => {
  const f = setup()
  for (const value of [
    undefined,
    {},
    f.boundary(-1),
    f.boundary(1.5),
    f.boundary(10, { activeTurn: undefined }),
    f.boundary(10, { activeTurn: { id: 'turn', threadId: 'thread', status: 'running' } }),
    f.boundary(10, { activeTurn: { id: 'turn', threadId: 'other', status: 'running' } }),
    f.boundary(10, { activeTurn: { id: 'turn', threadId: 'thread', status: 'completed' } }),
  ]) {
    expect(f.seed(value)).toBe(false)
  }
  f.input(20)
  expect(f.inputs()).toEqual([])
})

test('terminal and newer notification fences reject late active and idle snapshots', () => {
  const f = setup()
  f.seed(f.boundary())
  f.input(11)
  expect(f.seed(f.boundary(10, { activeTurn: null }))).toBe(false)
  expect(f.inputs()).toHaveLength(1)
  f.send('turn/completed', 12)
  expect(f.seed(f.boundary(13))).toBe(false)
  f.input(14)
  expect(f.inputs()).toEqual([])
})

test('idle boundary cannot infer a turn from progress and a real next start remains usable', () => {
  const f = setup()
  expect(f.seed(f.boundary(10, { activeTurn: null }))).toBe(true)
  f.input(11)
  expect(f.inputs()).toEqual([])
  f.send('turn/started', 12, { turnId: 'next', attemptId: 'next-attempt' })
  f.input(13, f.client, { turnId: 'next', attemptId: 'next-attempt' })
  expect(f.inputs()).toHaveLength(1)
})

test('authoritative reconnection replaces only its client and preserves retired instance fences', () => {
  const f = setup()
  f.seed(f.boundary())
  f.input(11)
  f.consumer.disconnect(f.client)
  const replacement = {}
  expect(f.seed(f.boundary(12), replacement)).toBe(true)
  f.input(13, f.client)
  expect(f.inputs()).toEqual([])
  f.input(13, replacement)
  expect(f.inputs()).toHaveLength(1)
  expect(f.seed(f.boundary(14), f.client)).toBe(false)
  const restarted = {}
  expect(f.seed(f.boundary(1, { serverId: 'new-instance' }), restarted)).toBe(true)
  expect(f.seed(f.boundary(100), replacement)).toBe(false)
})
