import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExpertTaskDialog } from './ExpertTaskDialog'
import { ExpertClient, newExpert } from './client'
import { OfficeController } from '@/features/office-integration/controller'

const startExpertTask = vi.hoisted(() => vi.fn())
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ startExpertTask }) }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
const scope = {
  accountId: 'account',
  targetId: 'target',
  workspaceId: 'workspace',
  identityGeneration: 'generation',
  targetRevision: 'revision',
}
const definition = {
  ...newExpert('en'),
  id: 'personal.expert',
  title: 'Original expert',
  description: 'Original',
  instructions: 'Original instructions',
}
const saved = {
  owner: {
    accountId: 'account',
    targetId: 'target',
    workspaceId: 'workspace',
    organizationId: null,
  },
  definition,
  version: '1',
  definitionSha256: 'a'.repeat(64),
  createdAtMs: 1,
  archived: false,
}
function client(items = [saved]) {
  const call = vi.fn(async (_method, request) => ({
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: null,
    entityRevision: null,
    status: 'completed',
    observedAt: new Date().toISOString(),
    error: null,
    result: { items, total: items.length, nextCursor: null },
  }))
  return {
    value: new ExpertClient(new OfficeController({ call }, () => scope), {
      serverId: 'original-server',
      workspacePath: '/original',
    }),
    call,
  }
}
beforeEach(() => startExpertTask.mockClear())

it('reveals saved versions only after expert selection and applies only the selected fixed version', async () => {
  const fixture = client(), select = vi.fn(), close = vi.fn()
  vi.spyOn(fixture.value, 'list').mockResolvedValue({
    items: [{ definition, builtin: false }], total: 1, nextCursor: null,
  })
  render(<ExpertTaskDialog client={fixture.value}
    onSelect={select} onClose={close} />)
  await screen.findByRole('option', { name: 'Original expert' })
  expect(screen.queryByLabelText('version')).not.toBeInTheDocument()
  expect(screen.queryByText('task.prepareHint')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'task.apply' })).not.toBeInTheDocument()
  expect(fixture.call).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox', { name: 'task.selectorLabel' }), {
    target: { value: `expert:${definition.id}` },
  })
  await screen.findByRole('option', { name: 'Original expert · 1' })
  expect(screen.getByRole('button', { name: 'task.apply' })).toBeDisabled()
  expect(select).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('version'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'task.apply' }))
  await waitFor(() => expect(select).toHaveBeenCalledOnce())
  expect(select).toHaveBeenCalledWith(expect.objectContaining({
    deviceId: 'original-server', workspacePath: '/original',
    reference: { id: definition.id, version: '1', definitionSha256: 'a'.repeat(64) },
  }))
  expect(startExpertTask).not.toHaveBeenCalled()
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(fixture.call.mock.calls.every(([method]) => method === 'integrations/assistant/versions')).toBe(true)
})

it('offers no expert in the same selector without a separate clear button', async () => {
  const fixture = client(), clear = vi.fn(async () => {}), close = vi.fn()
  render(<ExpertTaskDialog client={fixture.value} onClear={clear} onClose={close} />)
  const selector = screen.getByRole('combobox', { name: 'task.selectorLabel' })
  await waitFor(() => expect(selector).toBeEnabled())
  expect(screen.queryByRole('button', { name: 'task.noExpert' })).not.toBeInTheDocument()
  fireEvent.change(selector, { target: { value: 'none' } })
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(clear).toHaveBeenCalledOnce()
  expect(startExpertTask).not.toHaveBeenCalled()
  expect(fixture.call.mock.calls.some(([method]) => method === 'integrations/assistant/versions')).toBe(false)
})

it('prepares only the selected immutable original-owner version without adopting or executing', async () => {
  const fixture = client()
  const close = vi.fn()
  render(
    <ExpertTaskDialog
      client={fixture.value}
      initial={{ definition, builtin: false }}
      onClose={close}
    />
  )
  const version = await screen.findByRole('option', { name: 'Original expert · 1' })
  expect(version).toBeInTheDocument()
  expect(startExpertTask).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('version'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'task.prepare' }))
  expect(startExpertTask).toHaveBeenCalledExactlyOnceWith({
    deviceId: 'original-server',
    workspacePath: '/original',
    title: 'Original expert',
    reference: { id: definition.id, version: '1', definitionSha256: 'a'.repeat(64) },
  })
  expect(fixture.call.mock.calls.map(([method]) => method)).toEqual([
    'integrations/assistant/versions',
  ])
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})

it('does not offer foreign-owner or archived versions', async () => {
  const fixture = client([
    { ...saved, archived: true },
    { ...saved, owner: { ...saved.owner, accountId: 'another-owner' } },
  ])
  render(
    <ExpertTaskDialog
      client={fixture.value}
      initial={{ definition, builtin: false }}
      onClose={() => {}}
    />
  )
  await waitFor(() => expect(screen.getByText('task.saveVersionFirst')).toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'task.prepare' })).toBeDisabled()
  expect(startExpertTask).not.toHaveBeenCalled()
})
