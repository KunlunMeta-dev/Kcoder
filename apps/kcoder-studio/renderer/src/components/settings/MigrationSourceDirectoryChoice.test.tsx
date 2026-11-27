import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { MigrationSourceDirectoryChoice } from './MigrationSourceDirectoryChoice'
import { validSourceDirectory, sourceDirectoryChoiceReady } from '@/kcoder/migrationSourceDirectoryIntent'

it('defaults to configured source directories and never offers a local browser file picker', () => {
  const change = vi.fn(), value = { explicit: false, path: '' }
  const { rerender } = render(<MigrationSourceDirectoryChoice value={value} onChange={change} disabled={false}/>)
  expect(screen.queryByTestId('migration-source-directory-path')).toBeNull()
  fireEvent.click(screen.getByTestId('migration-source-directory-explicit'))
  expect(change).toHaveBeenCalledWith({ explicit: true, path: '' })
  rerender(<MigrationSourceDirectoryChoice value={{ explicit: true, path: '/on/source/.claude' }} onChange={change} disabled={false}/>)
  expect(screen.getByLabelText('来源设备上的产品目录（绝对路径）')).toHaveValue('/on/source/.claude')
  expect(screen.getByText(/不是浏览器本机目录/)).toBeTruthy()
  expect(document.querySelector('input[type=file]')).toBeNull()
  expect(sourceDirectoryChoiceReady({ explicit: true, path: '' })).toBe(false)
})
it('bounds lexical source paths without inventing the source operating system authority', () => {
  for (const path of ['/remote/product', 'D:\\remote\\product', '\\\\server\\share\\product']) expect(validSourceDirectory(path)).toBe(true)
  for (const path of ['', 'relative/product', 'C:relative', '/control\npath', '/' + '中'.repeat(1366)]) expect(validSourceDirectory(path)).toBe(false)
})
