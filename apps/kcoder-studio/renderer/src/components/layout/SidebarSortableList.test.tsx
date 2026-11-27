import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SidebarSortableList } from './SidebarSortableList'

test('disabling task reordering leaves its recovery controls operable', async () => {
  const recover = vi.fn()
  render(
    <SidebarSortableList
      testId="recovery-list"
      items={['failed-task']}
      getId={item => item}
      getLabel={item => item}
      canDrag={() => false}
      onMove={vi.fn()}
      renderItem={() => (
        <div>
          <button onClick={recover}>Query original creation</button>
          <details><summary>Failure details</summary>Transport disconnected</details>
        </div>
      )}
    />
  )
  const button = screen.getByRole('button', { name: 'Query original creation' })
  expect(button.closest('[aria-disabled="true"]')).toBeNull()
  expect(screen.getByText('Failure details').closest('[aria-disabled="true"]')).toBeNull()
  await userEvent.tab()
  expect(button).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  expect(recover).toHaveBeenCalledOnce()
})
