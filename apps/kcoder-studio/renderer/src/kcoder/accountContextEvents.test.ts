import { afterEach, expect, test, vi } from 'vitest'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
  notifyAccountContextChange,
} from './accountContextEvents'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
  vi.unstubAllGlobals()
})
class TestChannel {
  static instances: TestChannel[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  readonly name: string
  constructor(name: string) {
    this.name = name
    TestChannel.instances.push(this)
  }
  postMessage(data: unknown) {
    for (const channel of TestChannel.instances)
      if (!channel.closed && channel !== this) channel.onmessage?.({ data })
  }
  close() {
    this.closed = true
  }
}
function subscribe(handler: (id: string) => void) {
  const stop = listenAccountContextChanges(handler)
  cleanups.push(stop)
}
test('multiple local listeners observe one revision, including a new request started by the first listener', () => {
  vi.stubGlobal('BroadcastChannel', TestChannel)
  let afterFirst: ((target: string) => boolean) | undefined
  const seen: string[] = []
  subscribe(id => {
    seen.push(`first:${id}`)
    afterFirst = captureAccountContextRevision()
  })
  subscribe(id => {
    seen.push(`second:${id}`)
    expect(afterFirst?.(id)).toBe(true)
  })
  const before = captureAccountContextRevision()
  notifyAccountContextChange('same-window-target')
  expect(before('same-window-target')).toBe(false)
  expect(afterFirst?.('same-window-target')).toBe(true)
  expect(seen).toEqual(['first:same-window-target', 'second:same-window-target'])
  const afterOld = afterFirst!
  notifyAccountContextChange('same-window-target')
  expect(afterOld('same-window-target')).toBe(false)
  expect(seen).toHaveLength(4)
})
test('one broadcast receiver fans out once, deduplicates an event id, and accepts the next event from the same source and target', () => {
  TestChannel.instances = []
  vi.stubGlobal('BroadcastChannel', TestChannel)
  let captured: ((target: string) => boolean) | undefined
  const first = vi.fn((id: string) => {
    captured = captureAccountContextRevision()
  })
  const second = vi.fn((id: string) => expect(captured?.(id)).toBe(true))
  subscribe(first)
  subscribe(second)
  expect(TestChannel.instances.filter(c => !c.closed)).toHaveLength(1)
  const remote = new TestChannel('kcoder-account-context')
  const event = {
    type: 'account-changed',
    source: 'other-window',
    targetId: 'broadcast-target',
    eventId: 'other-window:1',
  }
  remote.postMessage(event)
  const afterFirst = captured!
  remote.postMessage(event)
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  expect(afterFirst('broadcast-target')).toBe(true)
  remote.postMessage({ ...event, eventId: 'other-window:2' })
  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledTimes(2)
  expect(afterFirst('broadcast-target')).toBe(false)
  const beforeLegacy = captured!
  remote.postMessage({
    type: 'account-changed',
    source: 'legacy-window',
    targetId: 'broadcast-target',
  })
  expect(first).toHaveBeenCalledTimes(3)
  expect(second).toHaveBeenCalledTimes(3)
  expect(beforeLegacy('broadcast-target')).toBe(false)
  remote.close()
})

test('a failed subscriber cannot block other invalidation handlers or disclose its error', () => {
  vi.stubGlobal('BroadcastChannel', TestChannel)
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const second = vi.fn()
  subscribe(() => { throw new Error('private-fixture-value') })
  subscribe(second)
  try {
    const before = captureAccountContextRevision()
    notifyAccountContextChange('listener-failure-target')
    expect(before('listener-failure-target')).toBe(false)
    expect(second).toHaveBeenCalledWith('listener-failure-target')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[KCoder] account context listener failed')
  } finally { diagnostic.mockRestore() }
})
