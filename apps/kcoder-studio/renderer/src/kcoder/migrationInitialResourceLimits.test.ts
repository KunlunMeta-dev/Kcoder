import { expect, it } from 'vitest'
import { createInitialResourceDraft, initialResourceSelection, sameInitialResourceSelection } from '../../../shared/migrationInitialResourceLimits'
it('omits all limits until the user explicitly chooses them, even when the unsent fields are invalid', () => {
  const draft = createInitialResourceDraft()
  expect(initialResourceSelection(draft)).toEqual({ valid: true })
  expect(initialResourceSelection({ ...draft, maxTotalBytes: 'wrong' })).toEqual({ valid: true })
  const result = initialResourceSelection({ ...draft, enabled: true })
  expect(result.valid).toBe(true)
  expect(result.limits).toEqual({ maxTotalBytes: 21474836480, maxPayloadFiles: 10000, minFreeBytes: 134217728, minFreeFileNodes: 32 })
  expect(Object.isFrozen(result.limits)).toBe(true)
})
it('enforces the actual Native bounds without coercing fractions, scientific notation or unsafe integers', () => {
  const draft = { ...createInitialResourceDraft(), enabled: true }
  for (const patch of [{ maxTotalBytes: '0' }, { maxTotalBytes: '549755813889' }, { maxTotalBytes: '9007199254740993' }, { maxTotalBytes: '1e9' }, { maxPayloadFiles: '1.5' }, { maxPayloadFiles: '16385' }, { minFreeBytes: '1048575' }, { minFreeBytes: '17179869185' }, { minFreeFileNodes: '-1' }, { minFreeFileNodes: '16385' }]) expect(initialResourceSelection({ ...draft, ...patch })).toEqual({ valid: false })
  expect(initialResourceSelection({ ...draft, maxTotalBytes: '1', maxPayloadFiles: '1', minFreeBytes: '1048576', minFreeFileNodes: '0' }).valid).toBe(true)
})
it('compares omitted defaults separately from explicit initial limits after a lost creation acknowledgement', () => {
  const limits = initialResourceSelection({ ...createInitialResourceDraft(), enabled: true }).limits!
  expect(sameInitialResourceSelection(undefined, undefined)).toBe(true)
  expect(sameInitialResourceSelection(undefined, limits)).toBe(false)
  expect(sameInitialResourceSelection(limits, { ...limits })).toBe(true)
  expect(sameInitialResourceSelection(limits, { ...limits, minFreeFileNodes: 0 })).toBe(false)
})
