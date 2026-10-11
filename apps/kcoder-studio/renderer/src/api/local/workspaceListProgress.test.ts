import { expect, test, vi } from 'vitest'
import { readWorkspaceList } from './workspaceListProgress'

test('delivers partial work before requesting the next revision and never starts a second scan', async () => {
  let finish!: (value: unknown) => void
  const request = vi
    .fn()
    .mockResolvedValueOnce({ scanId: 'scan', revision: 1, complete: false, workspaces: ['first'] })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  const onProgress = vi.fn()
  const result = readWorkspaceList(request, value => value.workspaces, onProgress)
  void result.catch(() => undefined)
  await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(['first']))
  expect(request.mock.calls).toEqual([
    [{ progressive: true }],
    [{ progressive: true, scanId: 'scan', afterRevision: 1 }],
  ])
  finish({ scanId: 'scan', revision: 2, complete: true, workspaces: ['first', 'second'] })
  await expect(result).resolves.toEqual(['first', 'second'])
  expect(onProgress).toHaveBeenCalledTimes(1)
})

test('keeps full and old-runtime responses compatible', async () => {
  const request = vi.fn().mockResolvedValue({ workspaces: ['full'] })
  await expect(readWorkspaceList(request, value => value.workspaces)).resolves.toEqual(['full'])
  expect(request).toHaveBeenLastCalledWith({})
  const onProgress = vi.fn()
  await expect(readWorkspaceList(request, value => value.workspaces, onProgress)).resolves.toEqual([
    'full',
  ])
  expect(onProgress).not.toHaveBeenCalled()
})

test('rejects changed scan identity and repeated revisions instead of looping', async () => {
  for (const next of [
    { workspaces: [] },
    { scanId: 'other', revision: 2, complete: true, workspaces: [] },
    { scanId: 'scan', revision: 1, complete: false, workspaces: [] },
    { scanId: 'scan', revision: 2, complete: false },
  ]) {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ scanId: 'scan', revision: 1, complete: false, workspaces: [] })
      .mockResolvedValueOnce(next)
    await expect(
      readWorkspaceList(
        request,
        value => value.workspaces,
        () => {}
      )
    ).rejects.toThrow('Invalid workspace scan response')
    expect(request).toHaveBeenCalledTimes(2)
  }
})
