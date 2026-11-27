import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationPrivateCredentials } from './MigrationPrivateCredentials'
import examples from '../../../../shared/generated/examples.migration-source-credentials.json'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationJobReadResult } from '../../../../shared/generated/contracts'
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown>, calls: {} as Record<string, ReturnType<typeof vi.fn>>, constructed: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/migrationSourceTransferScope', () => ({ migrationSourceRecoveryScope: (target: GatewayServer) => `${target.id}:${target.workspacePath}` }))
vi.mock('@/kcoder/migrationPrivateCredentialController', () => ({ StudioPrivateCredentialController: class {
  constructor(options: unknown) { fake.constructed(options) }
  snapshot = () => fake.state
  subscribe = () => () => {}
  activate = () => {}
  dispose = () => {}
  load = (...args: unknown[]) => fake.calls.load(...args)
  control = (...args: unknown[]) => fake.calls.control(...args)
  read = (...args: unknown[]) => fake.calls.read(...args)
  sourceRead = (...args: unknown[]) => fake.calls.sourceRead(...args)
  preparationRead = (...args: unknown[]) => fake.calls.preparationRead(...args)
  restorePreparation = (...args: unknown[]) => fake.calls.restorePreparation(...args)
  choose = (...args: unknown[]) => fake.calls.choose(...args)
} }))
const target = { id: 'target', label: 'Target', workspacePath: '/owned' } as GatewayServer
const job = { job: { jobId: 'owned', sequence: 7 }, batch: { planId: 'saved-plan' } } as MigrationJobReadResult
const run = examples.MigrationSourceCredentialRunParams[0].value
const props = () => ({ target, targets: [target], job, isCurrent: () => true, onPrepared: vi.fn(), onBusy: vi.fn() })
beforeEach(() => {
  fake.constructed.mockClear()
  for (const name of ['load', 'control', 'read', 'sourceRead', 'choose', 'preparationRead', 'restorePreparation']) fake.calls[name] = vi.fn()
  fake.state = { busy: false, controlBusy: false, error: null, page: null, selected: null, device: null,
    candidates: null, selections: {}, included: [], records: [], input: null, observed: {}, workers: {}, result: null }
})
it('retains the owned controller across equivalent parent descriptors and does not open children on render', () => {
  const p = props(), view = render(<MigrationPrivateCredentials {...p}/>)
  view.rerender(<MigrationPrivateCredentials {...p} target={{ ...target }} job={{ ...job }}/>)
  expect(fake.constructed).toHaveBeenCalledTimes(1)
  expect(fake.calls.load).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'title · details' }))
  fireEvent.click(screen.getByRole('button', { name: 'load_sources' }))
  expect(fake.calls.load).toHaveBeenCalledOnce()
})
it('allows receipt reads and explicit cancellation during a pending transfer, but keeps resume blocked', () => {
  fake.state = { ...fake.state, busy: true, input: run, device: { id: run.source.targetId } }
  render(<MigrationPrivateCredentials {...props()}/>)
  fireEvent.click(screen.getByRole('button', { name: 'title · details' }))
  fireEvent.click(screen.getByRole('button', { name: 'check_offer' }))
  fireEvent.click(screen.getByRole('button', { name: 'check_source' }))
  expect(fake.calls.read).toHaveBeenCalledOnce()
  expect(fake.calls.sourceRead).toHaveBeenCalledOnce()
  expect(screen.getAllByRole('button', { name: 'resume' }).every(button => button.hasAttribute('disabled'))).toBe(true)
  fireEvent.click(screen.getAllByRole('button', { name: 'cancel' })[0])
  fireEvent.change(screen.getByRole('textbox', { name: 'confirmation' }), { target: { value: 'CANCEL' } })
  fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
  expect(fake.calls.control).toHaveBeenCalledWith('source', 'cancel', undefined)
})
it('keeps a valid candidate selectable when its optional issue code is absent', () => {
  const candidate = structuredClone(examples.MigrationSourceCredentialCandidatesResult[1].value)
  delete candidate.items[0].issueCode
  fake.state = { ...fake.state, candidates: candidate, selected: {}, candidateIndex: 0 }
  render(<MigrationPrivateCredentials {...props()}/>)
  fireEvent.click(screen.getByRole('button', { name: 'title · details' }))
  const field = screen.getByRole('checkbox', { name: /field_environment/ })
  expect(field).not.toHaveAttribute('disabled')
  fireEvent.click(field)
  expect(fake.calls.choose).toHaveBeenCalledWith(candidate.items[0].itemId, { kind: 'mcp', fieldIndices: [0] })
})

it('reads the original intent without local offers and requires explicit pinned confirmation for pending preparation', () => {
  const pending = examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === 'pending')!.value
  fake.state = { ...fake.state, selected: {}, preparation: pending }
  const view = render(<MigrationPrivateCredentials {...props()}/>); fireEvent.click(screen.getByRole('button', { name: 'title · details' }))
  expect(fake.calls.preparationRead).not.toHaveBeenCalled(); expect(fake.calls.restorePreparation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-private-preparation-read')); expect(fake.calls.preparationRead).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByTestId('migration-private-preparation-restore'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'PREPARE' } })
  fake.state = { ...fake.state, preparation: { ...pending, expectedSequence: 2 } }; view.rerender(<MigrationPrivateCredentials {...props()}/>)
  expect(screen.getByRole('button', { name: 'confirm' })).toBeDisabled(); expect(fake.calls.restorePreparation).not.toHaveBeenCalled()
})

it('does not expose a replay button for prepared or unknown native status', () => {
  for (const phase of ['prepared', 'unknown', 'not_started']) {
    fake.state = { ...fake.state, selected: {}, preparation: examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === phase)!.value }
    const view = render(<MigrationPrivateCredentials {...props()}/>); fireEvent.click(screen.getByRole('button', { name: 'title · details' }))
    expect(screen.getByTestId('migration-private-preparation-status')).toHaveTextContent(`preparation_${phase}`)
    expect(screen.queryByTestId('migration-private-preparation-restore')).toBeNull(); view.unmount()
  }
})
