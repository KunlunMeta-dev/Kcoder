import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationInstructionSourceBrowser } from './MigrationInstructionSourceBrowser'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
const model = vi.hoisted(() => ({ busy: false, error: null, releasePending: false, intent: null, session: null, page: null, body: null,
  captureSource: vi.fn(), observe: vi.fn(), preview: vi.fn(), changePage: vi.fn(), close: vi.fn() }))
const transfer = vi.hoisted(() => ({ busy: false, requestId: null, result: null, start: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/useMigrationInstructionSources', () => ({ useMigrationInstructionSources: () => model }))
vi.mock('@/kcoder/useMigrationSourceTransfer', () => ({ useMigrationSourceTransfer: () => transfer }))
vi.mock('./MigrationSourceTransferStatus', () => ({ MigrationSourceTransferStatus: () => null }))
vi.mock('./MigrationSourceAdoptionPanel', () => ({ MigrationSourceAdoptionPanel: () => null }))
const source: GatewayServer = { id: 'source', label: 'Source', runtime: 'kcoder', transport: 'ssh', description: '', workspacePath: '/owned/default' }
beforeEach(() => { vi.clearAllMocks() })
it('never captures automatically and requires separately selected root, cwd and explicit static-subset consent', () => {
  render(<MigrationInstructionSourceBrowser source={source} destination={{ ...source, id: 'target' }} isCurrent={() => true} onBusy={vi.fn()}/>)
  expect(model.captureSource).not.toHaveBeenCalled()
  expect(screen.getByTestId('instruction-capture')).toBeDisabled()
  fireEvent.change(screen.getByTestId('instruction-source-root'), { target: { value: '/owned/authorized-root' } })
  fireEvent.change(screen.getByTestId('instruction-source-cwd'), { target: { value: '/owned/authorized-root/project' } })
  fireEvent.click(screen.getByTestId('instruction-descendants'))
  fireEvent.click(screen.getByTestId('instruction-static-consent'))
  fireEvent.click(screen.getByTestId('instruction-capture'))
  expect(model.captureSource).toHaveBeenCalledExactlyOnceWith({ source: 'claude-code', format: 'static_v2', sourceRoot: '/owned/authorized-root', sourceCwd: '/owned/authorized-root/project', includeDescendants: true, confirmStaticSubset: true })
  expect(transfer.start).not.toHaveBeenCalled()
})
