import { describe, expect, it } from 'vitest'
import { partitionPinnedProjects } from '../../../../../shared/projectPinning'

describe('shared Desktop/Mobile project pin partition', () => {
  it('keeps pinned and regular projects disjoint, with stable target order for ties', () => {
    const items = [
      { id: 'regular', pinned: false }, { id: 'late', pinned: true },
      { id: 'first', pinned: true, pinnedOrder: 0 }, { id: 'tie', pinned: true, pinnedOrder: 0 },
      { id: 'unknown' },
    ]
    const before = [...items]
    const result = partitionPinnedProjects(items, item => item)
    expect(result.pinned.map(item => item.id)).toEqual(['first', 'tie', 'late'])
    expect(result.regular.map(item => item.id)).toEqual(['regular', 'unknown'])
    expect(items).toEqual(before)
    expect(new Set([...result.pinned, ...result.regular]).size).toBe(items.length)
  })

  it('uses the same state rules through Desktop and Mobile data adapters', () => {
    const states = [{ pinned: true, pinnedOrder: 2 }, { pinned: false }, { pinned: true, pinnedOrder: 1 }, {}]
    const desktop = states.map((project, id) => ({ id, runtimeProjectWork: { project } }))
    const mobile = states.map((project, id) => ({ id, project }))
    const desktopGroups = partitionPinnedProjects(desktop, item => item.runtimeProjectWork.project)
    const mobileGroups = partitionPinnedProjects(mobile, item => item.project)
    for (const key of ['pinned', 'regular'] as const)
      expect(desktopGroups[key].map(item => item.id)).toEqual(mobileGroups[key].map(item => item.id))
  })

  it('moves only the changed project and keeps no phantom pinned group', () => {
    const a = { id: 'same-key-target-A', pinned: true }, b = { id: 'same-key-target-B', pinned: true }
    a.pinned = false
    expect(partitionPinnedProjects([a, b], item => item).pinned).toEqual([b])
    b.pinned = false
    expect(partitionPinnedProjects([a, b], item => item)).toEqual({ pinned: [], regular: [a, b] })
  })
})
