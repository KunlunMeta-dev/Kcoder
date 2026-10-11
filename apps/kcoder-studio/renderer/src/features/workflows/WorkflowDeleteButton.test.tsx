import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowDeleteButton } from './WorkflowDeleteButton'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./workflowApi', () => ({ workflowApi: { delete: vi.fn() } }))
test('cancel preserves entry; rejection stays visible; retry deletes captured revision', async () => {
  const onDeleted = vi.fn()
  vi.mocked(workflowApi.delete)
    .mockRejectedValueOnce(new Error('revision conflict'))
    .mockResolvedValue({ deleted: true })
  render(
    <WorkflowDeleteButton
      serverId="local"
      definition={{ id: 'flow', title: 'Flow', revision: 7 } as WorkflowDefinition}
      disabled={false}
      isCurrent={() => true}
      onDeleted={onDeleted}
    />
  )
  fireEvent.click(screen.getByTestId('workflow-delete'))
  fireEvent.click(screen.getByTestId('workflow-delete-cancel'))
  expect(workflowApi.delete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-delete'))
  fireEvent.click(screen.getByTestId('workflow-delete-confirm'))
  await screen.findByRole('alert')
  expect(onDeleted).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-delete-confirm'))
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
  expect(workflowApi.delete).toHaveBeenLastCalledWith('local', 'flow', 7)
})
