import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationCredentialPanel } from './MigrationCredentialPanel'
import type { MigrationJobReadResult } from '../../../../shared/generated/contracts'

const { api } = vi.hoisted(() => ({
  api: {
    planCredential: vi.fn(),
    applyCredential: vi.fn(),
    undoCredential: vi.fn(),
    read: vi.fn(),
  },
}))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const job = {
  job: {
    jobId: 'owned-job',
    sourceId: 'source',
    status: 'completed',
    sequence: 4,
    totalItems: 1,
    committedItems: 1,
    requiresActionItems: 1,
  },
  source: 'claude-code',
  plans: [],
  issues: [],
} as MigrationJobReadResult
const plan = {
  planId: 'credential-operation',
  itemId: 'provider',
  targetName: 'Imported',
  endpoint: 'https://example.invalid',
  storage: 'file',
  source: 'configuration',
  sourceField: 'env.ANTHROPIC_API_KEY',
  phase: 'ready',
} as const
const planned = { ...job, job: { ...job.job, sequence: 5 }, credentialPlans: [plan] }
beforeEach(() => {
  vi.resetAllMocks()
  api.planCredential.mockResolvedValue(planned)
})

test('credential reads require explicit consent and RPC carries only owned identities', async () => {
  const updated = vi.fn()
  render(
    <MigrationCredentialPanel
      deviceId="target"
      workspacePath="/owned"
      job={job}
      itemId="provider"
      isCurrent={() => true}
      onUpdated={updated}
      onBusy={() => {}}
      onClose={() => {}}
    />
  )
  expect(screen.getByRole('button', { name: 'credential.preview' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('credential.consent'))
  fireEvent.click(screen.getByRole('button', { name: 'credential.preview' }))
  await waitFor(() =>
    expect(api.planCredential).toHaveBeenCalledWith({
      jobId: 'owned-job',
      itemId: 'provider',
      expectedSequence: 4,
      source: 'configuration',
      consentApiKey: true,
    })
  )
  await screen.findByText('Imported')
  expect(updated).toHaveBeenCalledWith(planned)
  expect(document.querySelector('input[type=password]')).toBeNull()
})

test('a lost undo response preserves undo direction and the same operation identity', async () => {
  const published = { ...planned, credentialPlans: [{ ...plan, phase: 'published' as const }] }
  api.undoCredential
    .mockRejectedValueOnce(new Error('transport interrupted'))
    .mockResolvedValueOnce({
      ...published,
      job: { ...job.job, sequence: 9 },
      credentialPlans: [{ ...plan, phase: 'undone', undoRequested: true }],
    })
  api.read.mockResolvedValueOnce({
    ...published,
    job: { ...job.job, sequence: 7 },
    credentialPlans: [{ ...plan, phase: 'undoing', undoRequested: true }],
  })
  render(
    <MigrationCredentialPanel
      deviceId="target"
      job={published}
      itemId="provider"
      isCurrent={() => true}
      onUpdated={() => {}}
      onBusy={() => {}}
      onClose={() => {}}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'credential.undo' }))
  await screen.findByText('credential.phases.undoing')
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  await waitFor(() => expect(api.undoCredential).toHaveBeenCalledTimes(2))
  expect(api.undoCredential.mock.calls[1][0]).toEqual({
    jobId: 'owned-job',
    planId: 'credential-operation',
    expectedSequence: 7,
  })
  expect(api.applyCredential).not.toHaveBeenCalled()
})

test('a response from a replaced account cannot update the current workspace', async () => {
  let active = true,
    finish!: (value: MigrationJobReadResult) => void
  api.planCredential.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const updated = vi.fn()
  render(
    <MigrationCredentialPanel
      deviceId="target"
      job={job}
      itemId="provider"
      isCurrent={() => active}
      onUpdated={updated}
      onBusy={() => {}}
      onClose={() => {}}
    />
  )
  fireEvent.click(screen.getByLabelText('credential.consent'))
  fireEvent.click(screen.getByRole('button', { name: 'credential.preview' }))
  active = false
  await act(async () => {
    finish(planned)
  })
  expect(updated).not.toHaveBeenCalled()
})

test('grouped credentials expose batch recovery instead of independent mutation controls', () => {
  render(
    <MigrationCredentialPanel
      deviceId="target"
      job={{ ...planned, credentialPlans: [{ ...plan, grouped: true, phase: 'unknown' }] }}
      itemId="provider"
      isCurrent={() => true}
      onUpdated={() => {}}
      onBusy={() => {}}
      onClose={() => {}}
    />
  )
  expect(screen.getByText('credential.grouped')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'retry' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'credential.undo' })).toBeNull()
  expect(api.applyCredential).not.toHaveBeenCalled()
  expect(api.undoCredential).not.toHaveBeenCalled()
})
