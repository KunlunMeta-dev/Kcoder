import { StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  clearToolSelectionProjections,
  syncLocalToolSelectionProjection,
} from '@/kcoder/toolSelections'
import { ToolSelectionsStartupSync } from './ToolSelectionsStartupSync'

const account = vi.hoisted(() => ({ changed: undefined as (() => void) | undefined }))
vi.mock('@/kcoder/accountContextEvents', () => ({
  listenAccountContextChanges: (callback: () => void) => {
    account.changed = callback
    return () => {
      account.changed = undefined
    }
  },
}))
vi.mock('@/kcoder/toolSelections', () => ({
  clearToolSelectionProjections: vi.fn(),
  syncLocalToolSelectionProjection: vi.fn(async () => {}),
}))
beforeEach(() => {
  vi.clearAllMocks()
  account.changed = undefined
})

test('runs silently once per mounted application in StrictMode, isolates accounts and invalidates pending reads on unmount', async () => {
  const view = render(
    <StrictMode>
      <ToolSelectionsStartupSync />
    </StrictMode>
  )
  await waitFor(() => expect(syncLocalToolSelectionProjection).toHaveBeenCalledTimes(1))
  const firstCurrent = vi.mocked(syncLocalToolSelectionProjection).mock.calls[0][0]
  expect(firstCurrent()).toBe(true)
  view.rerender(
    <StrictMode>
      <ToolSelectionsStartupSync />
    </StrictMode>
  )
  expect(syncLocalToolSelectionProjection).toHaveBeenCalledTimes(1)
  act(() => account.changed?.())
  expect(firstCurrent()).toBe(false)
  expect(clearToolSelectionProjections).toHaveBeenCalled()
  expect(syncLocalToolSelectionProjection).toHaveBeenCalledTimes(2)
  const lastCurrent = vi.mocked(syncLocalToolSelectionProjection).mock.calls[1][0]
  view.unmount()
  expect(lastCurrent()).toBe(false)
})
