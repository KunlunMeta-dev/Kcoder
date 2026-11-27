import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { MigrationFirstUsePanel } from './MigrationFirstUsePanel'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

vi.mock('@/components/settings/MigrationDialog', () => ({ MigrationDialog: () => <div data-testid="owned-import-dialog" /> }))
const target = { id: 'owned-guide', transport: 'local' as const, workspacePath: '/guide', profile: 'owned' }
const settings = { profiles: [], restartRequired: false }
let marker: HTMLMetaElement
beforeEach(() => {
  localStorage.clear()
  marker = document.createElement('meta'); marker.name = 'kcoder-rpc-token'; marker.content = 'owned-fixture'; document.head.append(marker)
})
afterEach(() => { cleanup(); marker.remove(); vi.restoreAllMocks() })

test('the guide uses its original target DTO without a second directory baseline', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [target] }))
  render(<MigrationFirstUsePanel target={target} settings={settings} onRefresh={vi.fn()} />)
  await act(async () => {})
  expect(network).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('owned-import-dialog')).toBeVisible()
})

test('an account change still retires the original guide dialog and reads the current directory', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [target] }))
  render(<MigrationFirstUsePanel target={target} settings={settings} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  act(() => notifyAccountContextChange(target.id))
  expect(screen.queryByTestId('owned-import-dialog')).toBeNull()
  await waitFor(() => expect(network).toHaveBeenCalledOnce())
})
