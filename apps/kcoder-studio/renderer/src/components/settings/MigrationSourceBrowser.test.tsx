import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MigrationSourceBrowser } from './MigrationSourceBrowser'
import type { GatewayServer } from '@/kcoder/gatewayRpc'

const model = vi.hoisted(() => ({
  busy: false,
  releasePending: false,
  error: null,
  session: {
    sessionId: '22222222-2222-4222-8222-222222222222',
    purpose: 'source',
    targetId: 'source-device',
  },
  selections: vi.fn(),
  discover: vi.fn(),
  close: vi.fn(),
  result: {
    sources: Array.from({ length: 13 }, (_, index) => ({
      sourceId: `source-${index}`,
      displayName: `Source ${index + 1}`,
      scope: 'user',
    })),
  },
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'test-scope', isCurrent: () => true }),
}))
vi.mock('@/kcoder/useMigrationSourceDiscovery', () => ({
  useMigrationSourceDiscovery: () => model,
}))
const pluginProps = vi.hoisted(() => vi.fn())
vi.mock('./MigrationPluginSourceBrowser', () => ({
  MigrationPluginSourceBrowser: (props: unknown) => {
    pluginProps(props)
    return <div data-testid="uploaded-plugin-child" />
  },
}))
const source: GatewayServer = {
  id: 'source-device',
  label: 'Source device',
  description: '',
  runtime: 'kcoder',
  transport: 'ssh',
}
it('requires an explicit source choice and pages discovery results ten at a time', () => {
  render(
    <MigrationSourceBrowser
      targets={[source]}
      destination={source}
      isCurrent={() => true}
      onBusy={vi.fn()}
    />
  )
  expect(screen.queryByText('Source 1')).toBeNull()
  fireEvent.change(screen.getByLabelText('transferBrowser.source'), {
    target: { value: source.id },
  })
  expect(screen.getByText('Source 10')).toBeTruthy()
  expect(screen.queryByText('Source 11')).toBeNull()
  fireEvent.click(screen.getByText('next'))
  expect(screen.getByText('Source 13')).toBeTruthy()
  expect(screen.queryByText('Source 10')).toBeNull()
  expect(screen.getByText('transferBrowser.previewOnly')).toBeTruthy()
  expect(model.discover).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-source-mode-history'))
  expect(screen.getByTestId('migration-history-source-discover')).toBeTruthy()
  expect(model.discover).not.toHaveBeenCalled()
})

it('requires a source-device absolute directory before requesting explicitly scoped configuration discovery', () => {
  render(
    <MigrationSourceBrowser
      targets={[source]}
      destination={source}
      isCurrent={() => true}
      onBusy={vi.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText('transferBrowser.source'), {
    target: { value: source.id },
  })
  fireEvent.click(screen.getByTestId('migration-source-directory-explicit'))
  fireEvent.change(screen.getByTestId('migration-source-directory-path'), {
    target: { value: 'relative-folder' },
  })
  expect(screen.getByRole('button', { name: 'find' })).toBeDisabled()
  fireEvent.change(screen.getByTestId('migration-source-directory-path'), {
    target: { value: '/on/source/nondefault-product' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'find' }))
  expect(model.discover).toHaveBeenLastCalledWith(
    'claude-code',
    false,
    '/on/source/nondefault-product'
  )
})

it('keeps uploaded plugin inspection on its original destination and opaque product identity', () => {
  const uploaded = {
    operationId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'a'.repeat(64),
    source: 'codex' as const,
    totalFiles: 1,
    totalBytes: 1,
    receivedBytes: 1,
    verifiedBytes: 1,
    completedFiles: 1,
    sequence: 1,
    cancelWatermark: 0,
    cancelRequested: false,
    stage: 'ready' as const,
    workerState: 'stopped' as const,
  }
  render(
    <MigrationSourceBrowser
      targets={[]}
      destination={source}
      isCurrent={() => true}
      onBusy={vi.fn()}
      uploaded={uploaded}
    />
  )
  expect(screen.getByLabelText('transferBrowser.source')).toBeDisabled()
  fireEvent.click(screen.getByTestId('migration-source-mode-plugins'))
  expect(screen.getByTestId('uploaded-plugin-child')).toBeTruthy()
  expect(pluginProps).toHaveBeenLastCalledWith(
    expect.objectContaining({
      source,
      destination: source,
      fixedKind: 'codex',
      root: { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 },
    })
  )
})
