import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ExpertEditor } from './ExpertEditor'
import { newExpert } from './client'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

it('preserves an existing empty allowlist until the user explicitly selects task inheritance', async () => {
  const definition = { ...newExpert('en'), allowedTools: [] },
    onChange = vi.fn()
  render(
    <ExpertEditor
      definition={definition}
      isNew={false}
      onChange={onChange}
      onEditFile={() => {}}
      files={null}
      versions={null}
      showDetails={false}
    />
  )
  expect(screen.getByRole('combobox', { name: 'toolNames' })).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'toolAccess' }))
  fireEvent.click(await screen.findByText('inheritTaskTools'))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...definition, allowedTools: null }))
  expect(definition.allowedTools).toEqual([])
}, 15_000)

it('new experts inherit task tools and choosing a custom policy starts with an explicit empty list', async () => {
  const definition = newExpert('en'),
    onChange = vi.fn()
  render(
    <ExpertEditor
      definition={definition}
      isNew
      onChange={onChange}
      onEditFile={() => {}}
      files={null}
      versions={null}
      showDetails={false}
    />
  )
  expect(screen.queryByRole('combobox', { name: 'toolNames' })).toBeNull()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'toolAccess' }))
  fireEvent.click(await screen.findByText('restrictedTools'))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...definition, allowedTools: [] }))
}, 15_000)
