import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { usePluginTargetScope } from './usePluginTargetScope'
import { notifyAccountContextChange, captureAccountContextRevision } from './accountContextEvents'
const { servers } = vi.hoisted(() => ({ servers: vi.fn() }))
vi.mock('./gatewayRpc', () => ({ fetchGatewayServers: servers }))
afterEach(() => vi.resetAllMocks())
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
test('captured account revision rejects its owner change and preserves another target', () => {
  const valid = captureAccountContextRevision()
  notifyAccountContextChange('alpha')
  expect(valid('alpha')).toBe(false)
  expect(valid('beta')).toBe(true)
})
