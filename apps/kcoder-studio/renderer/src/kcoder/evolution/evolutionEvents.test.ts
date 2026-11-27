import { expect, test, vi } from 'vitest'
import { parseEvolutionChanged, publishEvolutionChanged, subscribeEvolutionChanged } from './evolutionEvents'

test('accepts only well-formed evolution/changed frames from a known target', () => {
  expect(parseEvolutionChanged('remote', { reason: 'promoted', targetKey: 'skill:user:x' })).toEqual({
    deviceId: 'remote',
    reason: 'promoted',
    targetKey: 'skill:user:x',
  })
  expect(parseEvolutionChanged(undefined, { reason: 'promoted' })).toBeNull()
  expect(parseEvolutionChanged('remote', { reason: 'other' })).toBeNull()
  expect(parseEvolutionChanged('remote', { reason: 'settings', targetKey: 3 })).toBeNull()
})

test('delivers to current subscribers only', () => {
  const listener = vi.fn()
  const stop = subscribeEvolutionChanged(listener)
  publishEvolutionChanged({ deviceId: 'remote', reason: 'settings' })
  stop()
  publishEvolutionChanged({ deviceId: 'remote', reason: 'cleared' })
  expect(listener).toHaveBeenCalledTimes(1)
})
