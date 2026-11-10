import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { MigrationPluginsPanel } from './MigrationPluginsPanel'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { MigrationPluginStateResult } from '../../../../shared/generated/contracts'

const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    ['discover', 'list', 'read', 'plan', 'capture', 'apply', 'undo', 'cancel', 'resume'].map(
      name => [name, vi.fn()]
    )
  ),
}))
vi.mock('@/kcoder/gatewayMigrationPlugins', () => ({ createMigrationPluginsApi: () => api }))

const isCurrent = () => true
function state(changes: object = {}): MigrationPluginStateResult {
  return {
    job: {
      operationId: 'owned-operation',
      sequence: 1,
      stage: 'ready',
      source: 'claude-code',
      name: 'sample',
      installedVersion: '1.0.0',
      scope: 'user',
      sourceEnabled: true,
      targetId: 'sample@migrated-fixture',
      packageFiles: 2,
      packageBytes: 32,
      capabilities: ['skills'],
      readiness: [],
      pending: [],
      imported: false,
      cancelRequested: false,
      cancelRevision: 0,
      ...changes,
    },
    workerRunning: false,
    workerError: null,
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.list.mockResolvedValue({ items: [state().job], nextCursor: null })
  api.read.mockResolvedValue(state())
  api.apply.mockResolvedValue(state({ sequence: 2, stage: 'imported', imported: true }))
  api.undo.mockResolvedValue(state({ sequence: 3, stage: 'undone', imported: true }))
})
async function openRecord() {
  fireEvent.click(await screen.findByTestId('migration-plugin-open-owned-operation'))
  await screen.findByTestId('migration-plugin-apply')
}

test('only explicit confirmation publishes a package and completion closes that confirmation', async () => {
  render(<MigrationPluginsPanel deviceId="target" isCurrent={isCurrent} />)
  await openRecord()
  expect(api.discover).not.toHaveBeenCalled()
  expect(api.capture).not.toHaveBeenCalled()
  expect(api.apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-plugin-apply'))
  expect(screen.getByTestId('migration-plugin-confirmation')).toBeInTheDocument()
  expect(api.apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-plugin-confirm'))
  await waitFor(() =>
    expect(api.apply).toHaveBeenCalledExactlyOnceWith({
      operationId: 'owned-operation',
      expectedSequence: 1,
    })
  )
  await waitFor(() =>
    expect(screen.queryByTestId('migration-plugin-confirmation')).not.toBeInTheDocument()
  )
  expect(screen.getByTestId('migration-plugin-undo')).toBeInTheDocument()
})

test('switching away and back cannot resurrect an old confirmation for the same operation ID', async () => {
  const { rerender } = render(<MigrationPluginsPanel deviceId="first" isCurrent={isCurrent} />)
  await openRecord()
  fireEvent.click(screen.getByTestId('migration-plugin-apply'))
  expect(screen.getByTestId('migration-plugin-confirmation')).toBeInTheDocument()
  rerender(<MigrationPluginsPanel deviceId="second" isCurrent={isCurrent} />)
  await waitFor(() =>
    expect(screen.queryByTestId('migration-plugin-confirmation')).not.toBeInTheDocument()
  )
  await openRecord()
  rerender(<MigrationPluginsPanel deviceId="first" isCurrent={isCurrent} />)
  await openRecord()
  expect(screen.queryByTestId('migration-plugin-confirmation')).not.toBeInTheDocument()
  expect(api.apply).not.toHaveBeenCalled()
})

test('account invalidation closes the confirmation even when the replacement account lists the same ID', async () => {
  render(<MigrationPluginsPanel deviceId="account-target" isCurrent={isCurrent} />)
  await openRecord()
  fireEvent.click(screen.getByTestId('migration-plugin-apply'))
  act(() => notifyAccountContextChange('account-target'))
  await waitFor(() =>
    expect(screen.queryByTestId('migration-plugin-confirmation')).not.toBeInTheDocument()
  )
  await openRecord()
  expect(screen.queryByTestId('migration-plugin-confirmation')).not.toBeInTheDocument()
  expect(api.apply).not.toHaveBeenCalled()
})

test('a late acknowledgement cannot close another target confirmation or publish there', async () => {
  let finish!: (value: MigrationPluginStateResult) => void
  api.apply.mockImplementation(
    () =>
      new Promise(done => {
        finish = done
      })
  )
  const { rerender } = render(<MigrationPluginsPanel deviceId="first" isCurrent={isCurrent} />)
  await openRecord()
  fireEvent.click(screen.getByTestId('migration-plugin-apply'))
  fireEvent.click(screen.getByTestId('migration-plugin-confirm'))
  await waitFor(() => expect(api.apply).toHaveBeenCalledOnce())
  rerender(<MigrationPluginsPanel deviceId="second" isCurrent={isCurrent} />)
  await openRecord()
  fireEvent.click(screen.getByTestId('migration-plugin-apply'))
  await act(async () => finish(state({ sequence: 2, stage: 'imported', imported: true })))
  expect(screen.getByTestId('migration-plugin-confirmation')).toBeInTheDocument()
  expect(api.apply).toHaveBeenCalledTimes(1)
  expect(api.undo).not.toHaveBeenCalled()
})

test('an undone operation retains its receipt but cannot offer another undo or installation', async () => {
  api.read.mockResolvedValue(state({ sequence: 3, stage: 'undone', imported: true }))
  render(<MigrationPluginsPanel deviceId="target" isCurrent={isCurrent} />)
  fireEvent.click(await screen.findByTestId('migration-plugin-open-owned-operation'))
  await screen.findByTestId('migration-plugin-result')
  expect(screen.queryByTestId('migration-plugin-undo')).not.toBeInTheDocument()
  expect(screen.queryByTestId('migration-plugin-apply')).not.toBeInTheDocument()
  expect(api.apply).not.toHaveBeenCalled()
  expect(api.undo).not.toHaveBeenCalled()
})

test('batch picker selects a prepared native package without standalone install or undo controls', async () => {
  const selected = vi.fn()
  render(
    <MigrationPluginsPanel
      deviceId="target"
      isCurrent={isCurrent}
      sourceKind="claude-code"
      onSelectForBatch={selected}
    />
  )
  fireEvent.click(await screen.findByTestId('migration-plugin-open-owned-operation'))
  await screen.findByTestId('migration-plugin-select-batch')
  expect(screen.queryByTestId('migration-plugin-apply')).not.toBeInTheDocument()
  expect(screen.queryByTestId('migration-plugin-undo')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('migration-plugin-select-batch'))
  expect(selected).toHaveBeenCalledExactlyOnceWith('owned-operation', 1, state().job.name)
  expect(api.apply).not.toHaveBeenCalled()
  expect(api.undo).not.toHaveBeenCalled()
})
