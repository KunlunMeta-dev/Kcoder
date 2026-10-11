import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowWorkspaceLocation } from './WorkflowWorkspaceLocation'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
test('missing directory is collected explicitly without starting a workflow and is trimmed', () => {
  const choose = vi.fn()
  const close = vi.fn()
  render(<WorkflowWorkspaceLocation onChoose={choose} onClose={close} />)
  expect(screen.getByTestId('workflow-location-confirm')).toBeDisabled()
  fireEvent.change(screen.getByTestId('workflow-location-input'), { target: { value: '   ' } })
  expect(screen.getByTestId('workflow-location-confirm')).toBeDisabled()
  fireEvent.change(screen.getByTestId('workflow-location-input'), {
    target: { value: ' D:\\work ' },
  })
  fireEvent.click(screen.getByTestId('workflow-location-confirm'))
  expect(choose).toHaveBeenCalledWith('D:\\work')
  fireEvent.click(screen.getByTestId('workflow-location-dialog-close'))
  expect(close).toHaveBeenCalledOnce()
})
