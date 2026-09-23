import { expect, test } from 'vitest'
import { TranscriptPageGate } from './transcriptPageGate'

test('reset rejects delayed navigation/older pages from the same task', () => {
  const gate = new TranscriptPageGate()
  const older = gate.begin('a')
  const navigation = gate.begin('a')
  expect(gate.accept(navigation, 'a', true)).toBe(true)
  expect(gate.accept(older, 'a', false)).toBe(false)
  expect(gate.accept(gate.begin('a'), 'a', false)).toBe(true)
})
test('scope changes and A to B to A cannot revive pending pages', () => {
  const gate = new TranscriptPageGate()
  const old = gate.begin('a')
  expect(gate.accept(old, 'b', false)).toBe(false)
  gate.invalidate()
  expect(gate.accept(old, 'a', false)).toBe(false)
})
