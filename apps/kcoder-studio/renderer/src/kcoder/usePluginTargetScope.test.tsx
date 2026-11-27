import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { usePluginTargetScope } from './usePluginTargetScope'
import type { GatewayServer } from './gatewayRpc'
import { notifyAccountContextChange, captureAccountContextRevision } from './accountContextEvents'
const { servers } = vi.hoisted(() => ({ servers: vi.fn() }))
vi.mock('./gatewayRpc', () => ({ fetchGatewayServers: servers }))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })

test('current target metadata supplies only the first fingerprint, while later configuration still reads', async () => {
  let target: GatewayServer = { id: 'known-target', label: 'Original', transport: 'local', command: 'original' }
  servers.mockImplementation(async () => [target])
  const view = renderHook(() => usePluginTargetScope(target.id, undefined, target))
  try {
    await act(async () => {})
    expect(servers).not.toHaveBeenCalled()
    const original = view.result.current
    target = { ...target, label: 'Renamed' }
    view.rerender()
    expect(view.result.current.key).toBe(original.key)
    expect(original.isCurrent()).toBe(true)
    const peer = renderHook(() => usePluginTargetScope(target.id, '/peer'))
    try {
      await act(async () => {})
      expect(servers).not.toHaveBeenCalled()
      const previousPeer = peer.result.current
      target = { ...target, command: 'replacement' }
      await act(async () => {
        window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
      })
      expect(servers).toHaveBeenCalledTimes(1)
      expect(original.isCurrent()).toBe(false)
      expect(previousPeer.isCurrent()).toBe(false)
    } finally { peer.unmount() }
  } finally { view.unmount() }
})

test('a parent target replacement retires the original lifetime without reading the same directory again', async () => {
  let target: GatewayServer = { id: 'known-replacement', label: 'Original', transport: 'local', profile: 'first' }
  const view = renderHook(() => usePluginTargetScope(target.id, undefined, target))
  try {
    const original = view.result.current
    target = { ...target, profile: 'second' }
    view.rerender()
    await act(async () => {})
    expect(original.isCurrent()).toBe(false)
    expect(view.result.current.key).not.toBe(original.key)
    expect(view.result.current.isCurrent()).toBe(true)
    expect(servers).not.toHaveBeenCalled()
  } finally { view.unmount() }
})

test('account invalidation does not reuse the supplied fingerprint instead of a current directory read', async () => {
  const target: GatewayServer = { id: 'known-account', label: 'Original', transport: 'local' }
  const response = { ...target, accountIdentity: { principalId: 'replacement', username: 'fixture', role: 'user' } }
  servers.mockResolvedValue([response])
  const view = renderHook(() => usePluginTargetScope(target.id, undefined, target))
  try {
    await act(async () => {})
    expect(servers).not.toHaveBeenCalled()
    const original = view.result.current
    await act(async () => { notifyAccountContextChange(target.id) })
    expect(original.isCurrent()).toBe(false)
    expect(servers).toHaveBeenCalledTimes(1)
    expect(view.result.current.isCurrent()).toBe(true)
  } finally { view.unmount() }
})

test('metadata for another target cannot seed the requested target observation', async () => {
  const target: GatewayServer = { id: 'real-requested', label: 'Real', transport: 'local' }
  servers.mockResolvedValue([target])
  const view = renderHook(() => usePluginTargetScope(target.id, undefined, { ...target, id: 'different-target' }))
  try {
    await act(async () => {})
    expect(servers).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
})

test.each([false, true])('releasing the last observer cancels only its real directory waiter with peer=%s', async withPeer => {
  const actual = await vi.importActual<typeof import('./gatewayRpc')>('./gatewayRpc')
  let finish!: (response: Response) => void
  let transportSignal!: AbortSignal
  const fetchImpl = vi.fn((_path: unknown, options?: RequestInit) => {
    transportSignal = options!.signal as AbortSignal
    return new Promise<Response>(resolve => { finish = resolve })
  })
  vi.stubGlobal('fetch', fetchImpl)
  servers.mockImplementation(actual.fetchGatewayServers)
  const view = renderHook(() => usePluginTargetScope(`http-observer-${withPeer}`))
  let peer: ReturnType<typeof actual.fetchGatewayServers> | undefined
  try {
    await act(async () => { await Promise.resolve() })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    if (withPeer) peer = actual.fetchGatewayServers()
    view.unmount()
    expect(transportSignal.aborted).toBe(!withPeer)
  } finally {
    view.unmount()
    finish(Response.json({ servers: [{ id: `http-observer-${withPeer}`, transport: 'local' }] }))
    if (peer) await expect(peer).resolves.toHaveLength(1)
    await act(async () => { await Promise.resolve() })
  }
})

test('a replacement aborts its old baseline and ignores even a non-cooperative late response', async () => {
  const target = { id: 'replaced-observer', command: 'current', transport: 'local' }
  let finish!: (value: typeof target[]) => void
  const signals: Array<AbortSignal | undefined> = []
  servers.mockImplementationOnce((_fetch, options) => {
    signals.push(options?.signal)
    return new Promise(resolve => { finish = resolve })
  }).mockImplementation((_fetch, options) => { signals.push(options?.signal); return Promise.resolve([target]) })
  const view = renderHook(() => usePluginTargetScope(target.id))
  try {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
      await Promise.resolve()
    })
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    const current = view.result.current
    await act(async () => { finish([{ ...target, command: 'old' }]); await Promise.resolve() })
    expect(view.result.current.key).toBe(current.key)
    expect(current.isCurrent()).toBe(true)
  } finally { view.unmount(); finish?.([target]) }
})
test('keeps strict-mode scope active, preserves rename, and invalidates only changed account or connection', async () => {
  let target = {
    id: 'alpha',
    label: 'A',
    transport: 'local',
    command: 'kcoder',
    workspace: '/workspace',
  }
  servers.mockImplementation(async () => [target])
  const view = renderHook(() => usePluginTargetScope('alpha', '/workspace'), {
    wrapper: StrictMode,
  })
  await waitFor(() => expect(servers).toHaveBeenCalled())
  const first = view.result.current
  expect(first.isCurrent()).toBe(true)
  act(() => notifyAccountContextChange('beta'))
  expect(first.isCurrent()).toBe(true)
  target = { ...target, label: 'Renamed' }
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'alpha' } })
    )
    await Promise.resolve()
  })
  expect(view.result.current.key).toBe(first.key)
  expect(first.isCurrent()).toBe(true)
  act(() => notifyAccountContextChange('alpha'))
  expect(first.isCurrent()).toBe(false)
  const second = view.result.current
  expect(second.key).not.toBe(first.key)
  expect(second.isCurrent()).toBe(true)
  target = { ...target, command: 'new-kcoder' }
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'alpha' } })
    )
    await Promise.resolve()
  })
  expect(second.isCurrent()).toBe(false)
  const third = view.result.current
  view.unmount()
  expect(third.isCurrent()).toBe(false)
})

test('does not bind an unselected scope to the first Gateway target', async () => {
  let firstTarget = {
    id: 'alpha',
    label: 'A',
    transport: 'local',
    command: 'kcoder',
    workspace: '/alpha',
  }
  servers.mockImplementation(async () => [firstTarget, { ...firstTarget, id: 'beta' }])
  const view = renderHook(() => usePluginTargetScope())
  expect(servers).not.toHaveBeenCalled()
  const unselected = view.result.current
  expect(unselected.isCurrent()).toBe(true)

  firstTarget = { ...firstTarget, command: 'changed-kcoder' }
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'alpha' } })
    )
    await Promise.resolve()
  })

  expect(view.result.current.key).toBe(unselected.key)
  expect(unselected.isCurrent()).toBe(true)
  expect(servers).not.toHaveBeenCalled()
  act(() => notifyAccountContextChange('alpha'))
  expect(unselected.isCurrent()).toBe(false)
  expect(view.result.current.isCurrent()).toBe(true)
  expect(servers).not.toHaveBeenCalled()
})

test('captured account revision rejects its owner change and preserves another target', () => {
  const valid = captureAccountContextRevision()
  notifyAccountContextChange('alpha')
  expect(valid('alpha')).toBe(false)
  expect(valid('beta')).toBe(true)
})

test('sequential mounts share the live target observer without sharing workspace lifetimes', async () => {
  let target = { id: 'shared-target', label: 'Original', transport: 'local', command: 'kcoder' }
  servers.mockImplementation(async () => [target])
  const first = renderHook(() => usePluginTargetScope(target.id, '/first'))
  await act(async () => { await Promise.resolve() })
  const second = renderHook(() => usePluginTargetScope(target.id, '/second'))
  await act(async () => { await Promise.resolve() })
  expect(servers).toHaveBeenCalledTimes(1)
  expect(first.result.current.key).not.toBe(second.result.current.key)
  const oldFirst = first.result.current, oldSecond = second.result.current
  target = { ...target, command: 'replacement' }
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  expect(servers).toHaveBeenCalledTimes(2)
  expect(oldFirst.isCurrent()).toBe(false)
  expect(oldSecond.isCurrent()).toBe(false)
  expect(first.result.current.isCurrent()).toBe(true)
  expect(second.result.current.isCurrent()).toBe(true)
})

test('a live peer retains observation, while the last unmount releases it and the next mount reads again', async () => {
  const target = { id: 'release-target', label: 'Original', transport: 'local', command: 'kcoder' }
  servers.mockResolvedValue([target])
  const first = renderHook(() => usePluginTargetScope(target.id))
  await act(async () => { await Promise.resolve() })
  const peer = renderHook(() => usePluginTargetScope(target.id))
  await act(async () => { await Promise.resolve() })
  first.unmount()
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  expect(servers).toHaveBeenCalledTimes(2)
  peer.unmount()
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  expect(servers).toHaveBeenCalledTimes(2)
  renderHook(() => usePluginTargetScope(target.id))
  await act(async () => { await Promise.resolve() })
  expect(servers).toHaveBeenCalledTimes(3)
})

test('a late pre-account read cannot replace the new observer baseline', async () => {
  const oldTarget = { id: 'late-observer', command: 'old-kcoder', transport: 'local', label: 'Old' }
  const target = { ...oldTarget, command: 'new-kcoder' }
  let finish!: (value: typeof oldTarget[]) => void
  servers.mockResolvedValueOnce([oldTarget])
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue([target])
  const view = renderHook(() => usePluginTargetScope(target.id))
  await act(async () => { await Promise.resolve() })
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  const old = view.result.current
  await act(async () => { notifyAccountContextChange(target.id); await Promise.resolve() })
  expect(old.isCurrent()).toBe(false)
  const current = view.result.current
  await act(async () => { finish([oldTarget]); await Promise.resolve() })
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  expect(view.result.current.key).toBe(current.key)
  expect(current.isCurrent()).toBe(true)
  expect(servers).toHaveBeenCalledTimes(4)
})

test('a failed cold baseline can be retried by a later subscriber', async () => {
  const target = { id: 'retry-observer', label: 'Original', transport: 'local', command: 'kcoder' }
  servers.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([target])
  const first = renderHook(() => usePluginTargetScope(target.id))
  await act(async () => { await Promise.resolve() })
  renderHook(() => usePluginTargetScope(target.id))
  await act(async () => { await Promise.resolve() })
  expect(servers).toHaveBeenCalledTimes(2)
  const previous = first.result.current
  servers.mockResolvedValue([{ ...target, label: 'Renamed' }])
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
    await Promise.resolve()
  })
  expect(first.result.current.key).toBe(previous.key)
  expect(previous.isCurrent()).toBe(true)
})

test('configuration reads begin after old HTTP retirement and coalesce the same event burst', async () => {
  servers.mockResolvedValue([{ id: 'event-observer', command: 'kcoder', transport: 'local' }])
  renderHook(() => usePluginTargetScope('event-observer'))
  await act(async () => { await Promise.resolve() })
  let retired = false
  const observedRetirement: boolean[] = []
  const retire = () => { retired = true }
  window.addEventListener('kcoder:servers-changed', retire)
  servers.mockImplementation(async () => {
    observedRetirement.push(retired)
    return [{ id: 'event-observer', command: 'replacement', transport: 'local' }]
  })
  try {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'event-observer' } }))
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'event-observer' } }))
      await Promise.resolve()
    })
    expect(servers).toHaveBeenCalledTimes(2)
    expect(observedRetirement).toEqual([true])
  } finally { window.removeEventListener('kcoder:servers-changed', retire) }
})

test('different targets retain independent fingerprints and invalidation', async () => {
  const alpha = { id: 'observer-alpha', command: 'alpha', transport: 'local' }
  let beta = { id: 'observer-beta', command: 'beta', transport: 'local' }
  servers.mockImplementation(async () => [alpha, beta])
  const first = renderHook(() => usePluginTargetScope(alpha.id))
  const second = renderHook(() => usePluginTargetScope(beta.id))
  await act(async () => { await Promise.resolve() })
  const oldAlpha = first.result.current, oldBeta = second.result.current
  beta = { ...beta, command: 'replacement' }
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: beta.id } }))
    await Promise.resolve()
  })
  expect(servers).toHaveBeenCalledTimes(3)
  expect(oldAlpha.isCurrent()).toBe(true)
  expect(first.result.current.key).toBe(oldAlpha.key)
  expect(oldBeta.isCurrent()).toBe(false)
})

test('changing Gateway mounts retires the old lifetime and rejects its late fingerprint', async () => {
  const prefix = document.createElement('meta')
  prefix.name = 'kcoder-app-base-path'
  prefix.content = '/g/observer-before'
  document.head.append(prefix)
  const target = { id: 'mount-observer', command: 'current', transport: 'local' }
  let finish!: (value: typeof target[]) => void
  servers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue([target])
  const first = renderHook(() => usePluginTargetScope(target.id))
  let closePeer: (() => void) | undefined
  try {
    const old = first.result.current
    prefix.content = '/g/observer-after'
    first.rerender()
    const peer = renderHook(() => usePluginTargetScope(target.id))
    closePeer = peer.unmount
    await act(async () => { await Promise.resolve() })
    expect(old.isCurrent()).toBe(false)
    expect(servers).toHaveBeenCalledTimes(2)
    const current = first.result.current
    await act(async () => { finish([{ ...target, command: 'old' }]); await Promise.resolve() })
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
      await Promise.resolve()
    })
    expect(first.result.current.key).toBe(current.key)
    expect(current.isCurrent()).toBe(true)
    expect(servers).toHaveBeenCalledTimes(3)
  } finally { first.unmount(); closePeer?.(); prefix.remove() }
})
