import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { TaskResourceBindings } from './TaskResourceBindings'
import type { ConnectionList } from './types'
import type { IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const source = { sourceRef: { id: 'original-source', revision: 'security-1' }, accountRef: null }
const snapshot: IntegrationTaskCapabilityScopeSnapshot = { threadId: 'original-thread', revision: 1, selection: { mode: 'inherit_current', sources: [] }, effectiveSources: [source], effectiveFrom: 'current_snapshot' }
const reference = { id: 'original-granted-reference', revision: '2', kind: 'document' }
const page: ConnectionList = { items: [{ id: 'original-application', revision: '3', kind: 'tencent_docs', label: 'Approved application', enabled: true, hasCredential: true, state: 'configured', configuration: { mcpServerName: 'actual-source' }, resourceGrants: [reference] }], catalog: { applications: [], channels: [] }, nextCursor: null, sources: [{ name: 'actual-source', pluginId: null, enabled: true, authorization: 'authorized', taskSourceChoice: source }] }

test('existing App grants are never automatically granted and explicit empty remains empty', async () => {
  const save = vi.fn().mockResolvedValue(undefined), load = vi.fn().mockResolvedValue(page)
  render(<TaskResourceBindings snapshot={snapshot} readOnly={false} load={load} save={save} />)
  const checkbox = await screen.findByRole('checkbox', { name: 'Approved application · Document 1' })
  expect(checkbox).not.toBeChecked()
  const submit = screen.getByRole('button', { name: 'Save task resource scope' })
  await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit)
  await waitFor(() => expect(save).toHaveBeenCalledWith([]))
  await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(checkbox); fireEvent.click(submit)
  await waitFor(() => expect(save).toHaveBeenLastCalledWith([{ source, connectionRef: { id: 'original-application', revision: '3' }, resourceRefs: [reference] }]))
})

test('same display/source name with a different native source revision supplies no resource choices', async () => {
  const changed = structuredClone(page); changed.sources![0].taskSourceChoice = { ...source, sourceRef: { ...source.sourceRef, revision: 'different-security-epoch' } }
  const load = vi.fn().mockResolvedValue(changed), save = vi.fn()
  render(<TaskResourceBindings snapshot={snapshot} readOnly={true} load={load} save={save} />)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save task resource scope' })).toBeDisabled()
  expect(save).not.toHaveBeenCalled()
})
