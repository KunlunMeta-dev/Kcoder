import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskArtifactViewer } from './TaskArtifactViewer'
import type {
  IntegrationRequest,
  IntegrationScope,
  OfficeArtifactManifest,
} from '../../../../../shared/generated/contracts'
const fixture = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (target: string, workspace: string) => ({
    key: JSON.stringify([target, workspace]),
    isCurrent: fixture.current,
  }),
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
const scope: IntegrationScope = {
  accountId: 'owned',
  targetId: 'target',
  workspaceId: 'workspace',
  identityGeneration: '1',
  targetRevision: '1',
}
const manifest: OfficeArtifactManifest = {
  schemaVersion: 1,
  id: 'original-artifact',
  revision: 3,
  owner: { accountId: 'owned', targetId: 'target', workspaceId: 'workspace' },
  task: { threadId: 'original-thread', turnId: 'original-turn' },
  kind: 'document',
  title: 'Original exact deliverable',
  format: 'docx',
  bytes: 8,
  sha256: 'a'.repeat(64),
  sourceRefs: [],
  verification: {
    status: 'pending',
    completedChecks: [],
    pendingChecks: ['reader'],
    readerStatus: 'pending',
    formulaCalculation: 'not_applicable',
  },
  createdAtMs: 1,
}
afterEach(() => {
  cleanup()
  fixture.request.mockReset()
  fixture.current = () => true
})
function reply(request: IntegrationRequest, result: unknown) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    status: 'completed',
    observedAt: '2026-10-25T00:00:00Z',
    result,
    error: null,
  }
}
function install() {
  fixture.request.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
    if (params.method === 'settings/integrations/office/read')
      return {
        effectiveEnabled: true,
        connectionEnabled: true,
        persistedEnabled: true,
        restartRequired: false,
        revision: 'a'.repeat(64),
      }
    if (params.method === 'integrations/scope/read') return scope
    if (params.method === 'integrations/artifact/read')
      return reply(params.params as IntegrationRequest, { manifest })
    if (params.method === 'integrations/artifact/export')
      return reply(params.params as IntegrationRequest, {
        export: { opaque: 'actual-export-fixture' },
      })
    throw new Error('Unexpected side effect or latest lookup')
  })
}
function view(
  reader = vi.fn(async () => ({
    status: 'download_requested' as const,
    filename: 'original.docx',
    bytes: 8,
    sha256: manifest.sha256,
  }))
) {
  render(
    <StrictMode>
      <TaskArtifactViewer
        target={{ serverId: 'local', workspacePath: '/owned' }}
        threadId="original-thread"
        references={[{ kind: 'artifact', id: manifest.id, revision: '3' }]}
        phase="unknown"
        readExport={reader}
        onClose={vi.fn()}
      />
    </StrictMode>
  )
  return reader
}
test('exact task artifacts use original refs and actual export reader without task creation or final-preview assumption', async () => {
  install()
  const reader = view()
  await screen.findByText(manifest.title)
  const calls = fixture.request.mock.calls.map(([, params]) => params.method)
  expect(calls).not.toContain('integrations/artifact/list')
  expect(calls).not.toContain('integrations/office/generate')
  expect(calls).not.toContain('integrations/artifact/verification')
  fireEvent.click(screen.getByRole('button', { name: 'download' }))
  await waitFor(() =>
    expect(screen.getByTestId('task-artifact-download-status')).toHaveAttribute(
      'data-status',
      'download_requested'
    )
  )
  expect(reader).toHaveBeenCalledWith(
    { opaque: 'actual-export-fixture' },
    expect.objectContaining({
      target: { serverId: 'local', workspacePath: '/owned' },
      scope,
      signal: expect.any(AbortSignal),
    })
  )
  expect(screen.getByTestId('task-artifact-download-status')).toHaveTextContent(
    'exportStatuses.download_requested'
  )
  expect(screen.getByText('previewAfterFinal')).toBeInTheDocument()
})
test('cancelled initialization discards a late scope and does not pretend loading continues', async () => {
  let release!: (scope: IntegrationScope) => void
  install()
  const original = fixture.request.getMockImplementation()!
  fixture.request.mockImplementation(async (method, params) =>
    params.method === 'integrations/scope/read'
      ? new Promise(done => {
          release = done
        })
      : original(method, params)
  )
  view()
  await waitFor(() => expect(release).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
  release(scope)
  await waitFor(() => expect(screen.getByText('nativeCancelled')).toBeInTheDocument())
  expect(screen.queryByText(manifest.title)).toBeNull()
  expect(screen.queryByText('nativeLoading')).toBeNull()
})

test('actual reader cancellation stays cancelled rather than successful save or generic failure', async () => {
  install()
  const { OfficeClientError } = await import('@/features/office-integration/controller')
  const reader = vi.fn(async () => {
    throw new OfficeClientError('OFFICE_CANCELLED', 'retry_read')
  })
  view(reader)
  await screen.findByText(manifest.title)
  fireEvent.click(screen.getByRole('button', { name: 'download' }))
  await waitFor(() =>
    expect(screen.getByTestId('task-artifact-download-status')).toHaveAttribute(
      'data-status',
      'cancelled'
    )
  )
  expect(screen.getByTestId('task-artifact-download-status')).not.toHaveTextContent(
    'exportStatuses.completed'
  )
})
