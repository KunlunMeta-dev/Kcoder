import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchProjectActions } from './useWorkbenchProjectActions'
import '@/i18n'

test.each(['project', 'task'] as const)(
  'rejects a negative %s pin receipt instead of refreshing as success',
  async kind => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, error: 'Pin was rejected' })
      .mockResolvedValue({ accepted: true })
    const refresh = vi.fn().mockResolvedValue(undefined)
    const options = {
      user: { id: 1 },
      state: {},
      services: {},
      dispatch: vi.fn(),
      refreshWorkLists: refresh,
      executorClient: {
        runtime: { setRuntimeProjectPinned: update, setRuntimeTaskPinned: update },
      },
    } as unknown as Parameters<typeof useWorkbenchProjectActions>[0]
    const { result } = renderHook(() => useWorkbenchProjectActions(options))
    const pin = () =>
      kind === 'project'
        ? result.current.setRuntimeProjectPinned({
            deviceId: 'local',
            projectKey: 'project',
            pinned: true,
          })
        : result.current.setRuntimeTaskPinned({
            deviceId: 'local',
            threadId: 'thread',
            pinned: true,
          })
    await act(async () => {
      await expect(pin()).rejects.toThrow('Pin was rejected')
    })
    expect(refresh).not.toHaveBeenCalled()
    await act(async () => {
      await pin()
    })
    expect(refresh).toHaveBeenCalledOnce()
  }
)
