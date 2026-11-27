import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MigrationInitialResourceForm } from './MigrationInitialResourceForm'
import { createInitialResourceDraft, initialResourceSelection } from '../../../../shared/migrationInitialResourceLimits'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
function Fixture() {
  const [draft, setDraft] = useState(createInitialResourceDraft)
  return <><MigrationInitialResourceForm draft={draft} onChange={setDraft}/><output data-testid="selection">{JSON.stringify(initialResourceSelection(draft))}</output></>
}
it('keeps target defaults until explicit selection, shows invalid drafts and never treats free margins as observed capacity', () => {
  render(<Fixture/>)
  expect(screen.getByTestId('selection').textContent).toBe('{"valid":true}')
  expect(screen.queryByTestId('migration-initial-maxTotalBytes')).toBeNull()
  fireEvent.click(screen.getByTestId('migration-initial-enabled'))
  expect(JSON.parse(screen.getByTestId('selection').textContent!).limits.minFreeBytes).toBe(134217728)
  fireEvent.change(screen.getByTestId('migration-initial-minFreeBytes'), { target: { value: '0' } })
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.getByTestId('selection').textContent).toBe('{"valid":false}')
  fireEvent.click(screen.getByTestId('migration-initial-enabled'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByTestId('selection').textContent).toBe('{"valid":true}')
})
