import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { PersonalExpertCard } from './PersonalExpertCard'
import { newExpert } from './client'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

function fixture() {
  const items = ['first', 'second'].map(id => ({
    definition: { ...newExpert('en'), id: 'personal.' + id, title: id },
    builtin: false,
  }))
  const actions = {
    onEdit: vi.fn(),
    onRefresh: vi.fn(),
    onRemove: vi.fn(),
    onToggle: vi.fn(),
    onCopy: vi.fn(),
    onUse: vi.fn(),
    onPersonalize: vi.fn(),
  }
  return { items, actions }
}

it('keeps secondary actions on their own card and deletes only after explicit confirmation', async () => {
  const { items, actions } = fixture()
  render(
    <>
      {items.map(item => (
        <PersonalExpertCard
          key={item.definition.id}
          item={item}
          busy={false}
          pending={false}
          {...actions}
        />
      ))}
    </>
  )
  const second = within(screen.getAllByTestId('expert-card')[1])
  expect(second.queryByText('personal.second')).not.toBeInTheDocument()
  await userEvent.click(second.getByRole('button', { name: 'edit' }))
  expect(actions.onEdit).toHaveBeenCalledExactlyOnceWith(items[1])
  await userEvent.click(second.getByRole('button', { name: 'more' }))
  await userEvent.click(screen.getByTestId('expert-copy-personal.second'))
  expect(actions.onCopy).toHaveBeenCalledExactlyOnceWith(items[1])
  await userEvent.click(second.getByRole('button', { name: 'more' }))
  await userEvent.click(screen.getByTestId('expert-delete-personal.second'))
  expect(actions.onRemove).not.toHaveBeenCalled()
  const dialog = within(screen.getByTestId('expert-delete-confirm'))
  await userEvent.click(dialog.getByRole('button', { name: 'delete', exact: true }))
  expect(actions.onRemove).toHaveBeenCalledExactlyOnceWith(items[1])
})

it('keeps menu, edit, conversation and toggle disabled while an operation outcome is pending', () => {
  const { items, actions } = fixture()
  render(<PersonalExpertCard item={items[0]} busy={false} pending {...actions} />)
  for (const name of ['more', 'edit', 'conversation.open']) {
    expect(screen.getByRole('button', { name })).toBeDisabled()
  }
  expect(screen.getByRole('switch')).toBeDisabled()
})
