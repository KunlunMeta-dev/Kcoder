import { renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { sessionAddressExpectation } from '../../../../../shared/sessionAddressExpectation.mjs'
import type { RuntimeTaskAddress } from '@/types/api'
import { useRuntimeTaskReadAddress } from './useRuntimeTaskReadAddress'

const original: RuntimeTaskAddress = {
  deviceId: 'target', taskId: 'task', threadId: 'parent', workspacePath: '/owned',
  expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'parent' },
}

test('equivalent Native selectors preserve the original read object across new DTOs and key ordering', () => {
  const hook = renderHook(({ address }) => useRuntimeTaskReadAddress(address), { initialProps: { address: original } })
  const first = hook.result.current
  hook.rerender({ address: { ...original, expectedSessionAddress: {
    threadId: 'parent', workspaceId: 'native-workspace', targetId: 'native-target',
  } } })
  expect(hook.result.current).toBe(first)
})

test('an in-place Native selector change creates a new snapshot without rewriting the original read', () => {
  const address = structuredClone(original)
  const hook = renderHook(({ address }) => useRuntimeTaskReadAddress(address), { initialProps: { address } })
  const first = hook.result.current
  address.expectedSessionAddress!.targetId = 'replacement-native-target'
  hook.rerender({ address: { ...address } })
  expect(hook.result.current).not.toBe(first)
  expect(first?.expectedSessionAddress?.targetId).toBe('native-target')
  expect(hook.result.current?.expectedSessionAddress?.targetId).toBe('replacement-native-target')
})

test.each([
  null,
  { targetId: '', workspaceId: 'native-workspace', threadId: 'parent' },
  { targetId: 'native-target', threadId: 'parent' },
  { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'parent', extra: undefined },
])('malformed selectors remain present for the existing selector rejection: %j', invalid => {
  const address = { ...original, expectedSessionAddress: invalid as unknown as RuntimeTaskAddress['expectedSessionAddress'] }
  const hook = renderHook(() => useRuntimeTaskReadAddress(address))
  expect(hook.result.current).toHaveProperty('expectedSessionAddress')
  expect(hook.result.current?.expectedSessionAddress).toBe(invalid)
  expect(() => sessionAddressExpectation(hook.result.current?.expectedSessionAddress, 'parent')).toThrow('SESSION_ADDRESS_EXPECTATION_INVALID')
})

test('a retained original task keeps its own Native constraint while presentation is enriched', () => {
  const current = { ...original, workspacePath: '/new-presentation', expectedSessionAddress: {
    targetId: 'presentation-target', workspaceId: 'presentation-workspace', threadId: 'parent',
  } }
  const hook = renderHook(() => useRuntimeTaskReadAddress(current, original))
  expect(hook.result.current?.workspacePath).toBe('/owned')
  expect(hook.result.current?.expectedSessionAddress).toEqual(original.expectedSessionAddress)
})
