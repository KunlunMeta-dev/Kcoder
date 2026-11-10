import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { MigrationReinterpretPanel } from './MigrationReinterpretPanel'
import type { useMigrationHistory } from '@/kcoder/useMigrationHistory'

const check = vi.fn(), confirm = vi.fn()
const preview = { sourceJobId: 'old-job', sourceSequence: 9, sourceRevision: 'foreign-records/3',
  parserRevision: 'foreign-records/4', canCreate: true, reasonCode: null }
const model = (value: Record<string, unknown> = {}) => ({ busy: false, reinterpretation: null,
  prepareReinterpretation: check, reinterpret: confirm, ...value }) as unknown as ReturnType<typeof useMigrationHistory>
beforeEach(() => vi.clearAllMocks())

test('inspection and confirmation remain separate user actions', () => {
  const { rerender } = render(<MigrationReinterpretPanel model={model()} />)
  const details = screen.getByTestId('migration-reinterpretation') as HTMLDetailsElement
  details.open = true
  expect(confirm).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '创建新记录并重新解析' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '检查重新解析能力' }))
  expect(check).toHaveBeenCalledExactlyOnceWith()
  expect(confirm).not.toHaveBeenCalled()
  rerender(<MigrationReinterpretPanel model={model({ reinterpretation: preview })} />)
  expect(screen.getByText('foreign-records/3')).toBeInTheDocument()
  expect(screen.getByText('foreign-records/4')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '创建新记录并重新解析' }))
  expect(confirm).toHaveBeenCalledExactlyOnceWith()
})

test('blocked previews do not offer creation and pending writes cannot be submitted twice', () => {
  const { rerender } = render(<MigrationReinterpretPanel model={model({ reinterpretation: { ...preview, canCreate: false, reasonCode: 'not_ready' } })} />)
  const details = screen.getByTestId('migration-reinterpretation') as HTMLDetailsElement
  details.open = true
  expect(screen.queryByRole('button', { name: '创建新记录并重新解析' })).not.toBeInTheDocument()
  rerender(<MigrationReinterpretPanel model={model({ busy: true, reinterpretation: preview })} />)
  expect(screen.getByRole('button', { name: '创建新记录并重新解析' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '创建新记录并重新解析' }))
  expect(confirm).not.toHaveBeenCalled()
})
