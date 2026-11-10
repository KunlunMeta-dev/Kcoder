import { afterEach, expect, test, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ list: vi.fn(), versions: vi.fn() }))
vi.mock('@/features/workflows/workflowApi', () => ({
  workflowApi: { list: fixture.list, versions: fixture.versions },
}))
vi.mock('@/kcoder/accountContextEvents', () => ({
  captureAccountContextRevision: () => () => true,
}))
import { nativeAutomationWorkflows } from './nativeAutomationWorkflows'
afterEach(() => {
  fixture.list.mockReset()
  fixture.versions.mockReset()
})
test('lists actual saved versions across original pages without saving, changing or selecting a draft', async () => {
  fixture.versions.mockResolvedValue([])
  fixture.list
    .mockResolvedValueOnce({
      items: [
        { id: 'code', title: 'Saved Code', status: 'saved', savedVersion: 2 },
        { id: 'draft', title: 'Unsubmitted draft', status: 'draft', savedVersion: null },
      ],
      truncated: true,
      nextOffset: 32,
    })
    .mockResolvedValueOnce({
      items: [{ id: 'other', title: 'Other saved Code', status: 'saved', savedVersion: 1 }],
      truncated: false,
    })
  expect(
    await nativeAutomationWorkflows('actual-target', () => true, new AbortController().signal)
  ).toEqual([
    { id: 'code', title: 'Saved Code', version: 2 },
    { id: 'other', title: 'Other saved Code', version: 1 },
  ])
  expect(fixture.list.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['actual-target', 0],
    ['actual-target', 32],
  ])
})
test('rejects a delayed saved-version page after target change', async () => {
  let current = true,
    settle!: (value: unknown) => void
  fixture.list.mockImplementation(
    () =>
      new Promise(resolve => {
        settle = resolve
      })
  )
  const pending = nativeAutomationWorkflows(
    'actual-target',
    () => current,
    new AbortController().signal
  )
  current = false
  settle({ items: [], truncated: false })
  await expect(pending).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
})

test('retains immutable saved v1 after the editable summary becomes a draft and uses the selected workspace', async () => {
  fixture.list.mockResolvedValue({
    items: [{ id: 'edited', title: 'Unsaved new title', status: 'draft', savedVersion: 1 }],
    truncated: false,
  })
  fixture.versions.mockResolvedValue([
    { version: 1, title: 'Original saved title', revision: 2, nodeCount: 1, savedAtMs: 1 },
  ])
  const signal = new AbortController().signal
  await expect(
    nativeAutomationWorkflows('owned-target', () => true, signal, '/selected-project')
  ).resolves.toEqual([{ id: 'edited', title: 'Original saved title', version: 1 }])
  expect(fixture.list).toHaveBeenCalledWith('owned-target', 0, {
    signal,
    workspacePath: '/selected-project',
  })
  expect(fixture.versions).toHaveBeenCalledWith('owned-target', 'edited', {
    signal,
    workspacePath: '/selected-project',
  })
})
