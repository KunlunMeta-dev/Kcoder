import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { validMigrationSourceObservation } from '../../../../shared/migrationSourceObservation'
import type { MigrationSourceTransferResult } from '../../../../shared/generated/contracts'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const id = '22222222-2222-4222-8222-222222222222'
const sha = 'a'.repeat(64)
const observation: MigrationSourceTransferResult = { requestId: id, coordinatorState: 'unknown', observation: 'observed', errorCode: null, progress: null,
  result: { requestId: id, scope: 'target', phase: 'ready', sourceObserved: false, sourceCapture: null, sourceState: null,
    sourceSnapshotControl: null, targetAdmissionControl: null, targetWorkerRunning: false,
    targetState: { sequence: 2, cancelWatermark: 0, ready: true, cancelled: false },
    receipt: { requestId: id, manifestSha256: sha, bytes: 1, entries: 1 },
    progress: { acceptedBytes: 1, totalBytes: 1, entries: 1, manifestSha256: sha, partsComplete: true } } }
function model(result: MigrationSourceTransferResult | null) {
  return { result, requestId: id, busy: false, error: null, start: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }
}
it('a confirmed receipt says received but never says imported, even with unknown coordinator cleanup', () => {
  expect(validMigrationSourceObservation(observation, id)).toBe(true)
  render(<MigrationSourceTransferStatus model={model(observation)} />)
  expect(screen.getByText('transferStatus.received')).toBeTruthy()
  expect(screen.getByText('transferStatus.notImported')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'cancel' })).toBeNull()
})
it('an unconfirmed response keeps recovery available and does not imply success', () => {
  const state = model(null)
  render(<MigrationSourceTransferStatus model={state} />)
  expect(screen.getByText('transferStatus.unknown')).toBeTruthy()
  expect(screen.queryByText('transferStatus.received')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(state.retry).toHaveBeenCalledOnce()
  expect(state.start).not.toHaveBeenCalled()
})
