import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowVerificationStorage } from './WorkflowVerificationStorage'
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const capacity = {
  backend: 'legacy_json',
  workflowCount: 1,
  workflowLimit: 256,
  savedVersionCount: 1,
  versionsPerWorkflowLimit: 32,
  usedBytes: 1024,
  byteLimit: 8_388_608,
  nearLimit: false,
  versions: { flow: 1 },
}
test('storage migration is an explicit reviewed operation and errors preserve the dialog', async () => {
  const change = vi.fn().mockRejectedValue(new Error('bounded backup quota'))
  const view = render(
    <WorkflowVerificationStorage
      capacity={capacity}
      isCurrent={() => true}
      onChangeStorage={change}
    />
  )
  fireEvent.click(screen.getByTestId('workflow-storage-action'))
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-storage-confirm'))
  await waitFor(() => expect(change).toHaveBeenCalledWith('migrate'))
  expect(await screen.findByRole('alert')).toHaveTextContent('bounded backup quota')
  expect(screen.getByRole('dialog')).toBeVisible()
  view.unmount()
})
test('disconnect makes confirmation inert and objects backend offers explicit rollback', () => {
  const change = vi.fn()
  const view = render(
    <WorkflowVerificationStorage
      capacity={{ ...capacity, backend: 'immutable_objects' }}
      isCurrent={() => true}
      onChangeStorage={change}
    />
  )
  expect(screen.getByTestId('workflow-storage-action')).toHaveTextContent(
    'workflowVerification.rollback'
  )
  fireEvent.click(screen.getByTestId('workflow-storage-action'))
  view.rerender(
    <WorkflowVerificationStorage
      capacity={{ ...capacity, backend: 'immutable_objects' }}
      disabled
      isCurrent={() => false}
      onChangeStorage={change}
    />
  )
  expect(screen.getByTestId('workflow-storage-confirm')).toBeDisabled()
  fireEvent.click(screen.getByTestId('workflow-storage-confirm'))
  expect(change).not.toHaveBeenCalled()
  view.unmount()
})
