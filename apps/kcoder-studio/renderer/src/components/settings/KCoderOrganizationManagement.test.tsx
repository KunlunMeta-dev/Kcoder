import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KCoderOrganizationManagement } from './KCoderOrganizationManagement'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

const manage = vi.hoisted(() => vi.fn())
vi.mock('@/kcoder/gatewayRpc', () => ({ manageGatewayAccounts: manage }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const accounts = [{ id: 'alice-id', username: 'alice' }]
const view = {
  organizationId: 'organization-one',
  revision: 7,
  members: [{ principalId: 'alice-id', roles: ['member'], disabled: false, directoryMapped: true }],
  resources: [{ id: 'knowledge:alice', kind: 'knowledge', visibility: 'private' }],
  auditExportResources: [],
}
beforeEach(() => {
  manage.mockReset()
})

test('ordinary auditor reads only its own projection and has no membership controls', async () => {
  manage.mockResolvedValue({ ...view, resources: [], auditExportResources: ['audit:organization'] })
  render(<KCoderOrganizationManagement serverId="remote" accounts={[]} auditOnly />)
  fireEvent.click(screen.getByText('organization.audit'))
  expect(
    await screen.findByRole('button', { name: 'organization.exportAudit' })
  ).toBeInTheDocument()
  expect(manage).toHaveBeenCalledWith('remote', { operation: 'organization.self' })
  expect(screen.queryByRole('button', { name: 'organization.saveMember' })).not.toBeInTheDocument()
  expect(screen.queryByText('organization.resources')).not.toBeInTheDocument()
  expect(screen.queryByTestId('organization-execution-settings')).not.toBeInTheDocument()
})

test('administrator model policy editor saves through the real management revision and old targets stay explicit', async () => {
  manage.mockResolvedValue({ ...view, executionPolicy: null })
  render(<KCoderOrganizationManagement serverId="remote" accounts={accounts} />)
  fireEvent.click(screen.getByText('organization.manage'))
  await screen.findByTestId('organization-execution-settings')
  fireEvent.click(screen.getByText('organization.execution.title'))
  fireEvent.click(screen.getByTestId('organization-execution-save'))
  await waitFor(() =>
    expect(manage).toHaveBeenCalledWith('remote', {
      operation: 'organization.executionPolicy',
      expectedRevision: 7,
      executionPolicy: { version: 1, modelRules: [], budgetPolicies: [] },
    })
  )
})

test('administrator sees private boundary and cannot export without a separate grant', async () => {
  manage.mockResolvedValue(view)
  render(<KCoderOrganizationManagement serverId="remote" accounts={accounts} />)
  fireEvent.click(screen.getByText('organization.manage'))
  expect(await screen.findByText('organization.privateBoundary')).toBeInTheDocument()
  expect(screen.getByText('organization.exportDenied')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'organization.exportAudit' })).not.toBeInTheDocument()
  expect(screen.getByText('organization.directoryMapped')).toBeInTheDocument()
})

test('membership change carries the observed policy revision and preserves directory binding', async () => {
  manage.mockResolvedValue(view)
  render(<KCoderOrganizationManagement serverId="remote" accounts={accounts} />)
  fireEvent.click(screen.getByText('organization.manage'))
  await screen.findByText('organization.privateBoundary')
  fireEvent.click(screen.getByRole('button', { name: 'accounts.disable' }))
  await waitFor(() =>
    expect(manage).toHaveBeenCalledWith('remote', {
      operation: 'organization.member',
      principalId: 'alice-id',
      roles: ['member'],
      disabled: true,
      expectedRevision: 7,
    })
  )
})

test('delayed prior target response cannot populate the new organization panel', async () => {
  let resolve: (value: unknown) => void = () => {}
  manage.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const rendered = render(
    <KCoderOrganizationManagement serverId="old-target" accounts={accounts} />
  )
  fireEvent.click(screen.getByText('organization.manage'))
  rendered.rerender(<KCoderOrganizationManagement serverId="new-target" accounts={accounts} />)
  resolve(view)
  await waitFor(() =>
    expect(screen.queryByText('organization.privateBoundary')).not.toBeInTheDocument()
  )
  expect(manage).toHaveBeenCalledTimes(1)
})

test('switching account on the same target clears the prior governance view and rejects its late response', async () => {
  let resolve: (value: unknown) => void = () => {}
  manage.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  render(<KCoderOrganizationManagement serverId="same-target" accounts={accounts} />)
  fireEvent.click(screen.getByText('organization.manage'))
  act(() => notifyAccountContextChange('same-target'))
  await act(async () => {
    resolve(view)
  })
  expect(screen.queryByText('organization.privateBoundary')).not.toBeInTheDocument()
})
