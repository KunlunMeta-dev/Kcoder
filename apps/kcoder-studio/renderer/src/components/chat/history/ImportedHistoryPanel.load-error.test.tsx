import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { ImportedHistoryPanel } from './ImportedHistoryPanel'

const loading = vi.hoisted(() => ({ attempts: vi.fn() }))
vi.mock('./ImportedHistoryContent', () => {
  loading.attempts()
  throw new Error('Controlled module failure /private/path?token=not-for-display')
})

test.each(['zh-CN', 'en'])('failed history UI stays local without repeated requests (%s)', async locale => {
  await i18n.changeLanguage(locale)
  const props = { deviceId: 'owned-target', source: { operationId: 'owned', sourceJobId: 'archive' }, isCurrent: () => true }
  const view = render(<><p>Current conversation remains usable</p><ImportedHistoryPanel {...props} /></>)
  const current = screen.getByText('Current conversation remains usable')
  const status = await screen.findByTestId('imported-history-module-status')
  await screen.findByText(locale === 'en'
    ? /Could not load the history view/
    : /暂时无法加载历史界面/)
  expect(status).toHaveAttribute('aria-busy', 'false')
  expect(view.container).not.toHaveTextContent('/private/path')
  const attempts = loading.attempts.mock.calls.length
  view.rerender(<><p>Current conversation remains usable</p><ImportedHistoryPanel {...props} workspacePath="/current" /></>)
  expect(screen.getByText('Current conversation remains usable')).toBe(current)
  expect(loading.attempts).toHaveBeenCalledTimes(attempts)
  await i18n.changeLanguage('zh-CN')
})
