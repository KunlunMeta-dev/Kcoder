import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowConversationCards } from './WorkflowConversationCards'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
const isCurrent = () => true
const t = (key: string, params?: { params?: string }) => params?.params ?? key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'target', isCurrent }),
}))
vi.mock('./workflowApi', () => ({ workflowApi: { read: vi.fn(), exportDefinition: vi.fn() } }))
test('publishing through canvas refreshes the card, and reuse reads the exact saved version', async () => {
  const draft = {
    id: 'flow',
    title: 'Draft',
    revision: 1,
    status: 'draft',
    nodes: [],
  } as unknown as WorkflowDefinition
  vi.mocked(workflowApi.read).mockResolvedValue(draft)
  vi.mocked(workflowApi.exportDefinition).mockResolvedValue({
    ...draft,
    title: 'Published',
    savedVersion: 1,
    status: 'saved',
  })
  const onUse = vi.fn()
  render(
    <WorkflowConversationCards
      serverId="local"
      references={[{ id: 'flow', title: 'Draft' }]}
      disabled={false}
      onOpen={() => {}}
      onUse={onUse}
      newConversation
    />
  )
  await screen.findByText('Draft')
  expect(screen.queryByTestId('workflow-card-use')).not.toBeInTheDocument()
  vi.mocked(workflowApi.read).mockResolvedValue({ ...draft, savedVersion: 1, status: 'saved' })
  window.dispatchEvent(
    new CustomEvent('kcoder:workflow-definition-changed', {
      detail: { serverId: 'local', id: 'flow' },
    })
  )
  fireEvent.click(await screen.findByTestId('workflow-card-use'))
  await waitFor(() => expect(onUse).toHaveBeenCalled())
  expect(workflowApi.exportDefinition).toHaveBeenCalledWith('local', 'flow', 1)
  expect(JSON.parse(onUse.mock.calls[0][0])).toEqual({ definition_id: 'flow', version: 1 })
})
