import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowVerificationPrepare } from './WorkflowVerificationPrepare'
import type { WorkflowDefinition } from './workflowApi'
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const definition = {
  id: 'workflow',
  title: 'Saved',
  description: '',
  revision: 3,
  status: 'saved',
  savedVersion: 2,
  createdAtMs: 0,
  updatedAtMs: 1,
  nodes: [
    { id: 'check', title: 'Actual check', config: { resultCheck: { source: 'return true;' } } },
  ],
} as WorkflowDefinition
test('preparation passes exact typed case and finite arguments without launching execution itself', async () => {
  const prepare = vi.fn().mockResolvedValue(undefined)
  const view = render(
    <WorkflowVerificationPrepare
      definition={definition}
      scenariosSupported
      workspace="/workspace"
      args='{"count":2,"enabled":false}'
      onClose={vi.fn()}
      onPrepared={prepare}
    />
  )
  expect(prepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-named-case'))
  expect(screen.getByTestId('workflow-prepare-send')).toBeDisabled()
  fireEvent.click(screen.getByTestId('workflow-case-check-check'))
  fireEvent.change(screen.getByTestId('workflow-case-id'), { target: { value: 'equality' } })
  fireEvent.click(screen.getByTestId('workflow-prepare-send'))
  await waitFor(() =>
    expect(prepare).toHaveBeenCalledWith(
      '/workspace',
      { count: 2, enabled: false },
      { id: 'equality', requiredCheckNodes: ['check'] }
    )
  )
  view.unmount()
})
test('invalid JSON preserves input and does not prepare a hidden run', async () => {
  const prepare = vi.fn()
  const view = render(
    <WorkflowVerificationPrepare
      definition={definition}
      workspace="/workspace"
      args="{"
      onClose={vi.fn()}
      onPrepared={prepare}
    />
  )
  fireEvent.click(screen.getByTestId('workflow-prepare-send'))
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(prepare).not.toHaveBeenCalled()
  expect(screen.getByTestId('workflow-reuse-args')).toHaveValue('{')
  view.unmount()
})
