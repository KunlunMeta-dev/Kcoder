import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import '@/i18n'
import { MigrationDiscoveryProblems } from './MigrationDiscoveryProblems'

test('explains source permission failures instead of claiming the installation is missing', () => {
  render(
    <MigrationDiscoveryProblems
      problems={[
        { kind: 'claude-code', scope: 'user', code: 'migration_source_directory_untrusted' },
        { kind: 'codex', scope: 'user', code: 'migration_source_unreadable_or_unsupported' },
      ]}
    />
  )
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('Claude Code')
  expect(status).toHaveTextContent('其他账户具有修改权限')
  expect(status).toHaveTextContent('Codex')
  expect(status).toHaveTextContent('来源配置无法读取或格式尚未支持')
  expect(status).not.toHaveTextContent('没有找到')
})

test('unknown codes never echo private error text and duplicate observations appear once', () => {
  const problem = { kind: 'codex' as const, scope: 'user', code: 'raw-secret-error' }
  render(<MigrationDiscoveryProblems problems={[problem, problem]} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.getByRole('status')).toHaveTextContent('请核对文件的读取权限及配置格式')
  expect(screen.getByRole('status')).not.toHaveTextContent('raw-secret-error')
})

test('successful or absent discovery does not show an error', () => {
  render(<MigrationDiscoveryProblems problems={[]} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
