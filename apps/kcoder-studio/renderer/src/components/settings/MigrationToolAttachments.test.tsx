import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationToolAttachments } from './MigrationToolAttachments'
const { api } = vi.hoisted(() => ({
  api: { historyAttachmentRead: vi.fn(), historyAttachmentItems: vi.fn() },
}))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => api }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./MigrationHistoryAttachment', () => ({
  MigrationHistoryAttachment: ({ context }: { context: { toolItemIndex: number } }) => (
    <p>child-{context.toolItemIndex}</p>
  ),
}))
const summary = {
  structured: true,
  attachments: 12,
  sourceItems: 14,
  unknownItems: 1,
  opaqueItems: 1,
}
beforeEach(() => {
  vi.resetAllMocks()
  api.historyAttachmentRead.mockResolvedValue({
    job: {
      id: 'collection',
      sequence: 3,
      stage: 'catalogued',
      processedBytes: 0,
      catalog: summary,
      info: null,
      failureCode: null,
      cancelRequested: false,
      cancelRevision: 0,
    },
    workerRunning: false,
    workerError: null,
  })
  api.historyAttachmentItems.mockResolvedValue({
    summary,
    items: Array.from({ length: 10 }, (_, index) => ({
      index,
      sourceArrayIndex: index + 1,
      sourceType: 'image',
    })),
    nextCursor: 10,
  })
})
test('catalogued results expose at most one backend page and child zero stays selectable', async () => {
  render(
    <MigrationToolAttachments
      context={{ deviceId: 'target', jobId: 'job', isCurrent: () => true }}
      position={4}
      blockIndex={0}
    />
  )
  await screen.findByText('tool_attachments.catalogued')
  expect(screen.queryByText('attachment.download')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'tool_attachments.inspect' }))
  await screen.findByText('child-0')
  expect(screen.getAllByText(/^child-/)).toHaveLength(10)
  api.historyAttachmentItems.mockResolvedValue({
    summary,
    items: [
      { index: 10, sourceArrayIndex: 11, sourceType: 'image' },
      { index: 11, sourceArrayIndex: 12, sourceType: 'image' },
    ],
    nextCursor: null,
  })
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  await screen.findByText('child-10')
  expect(screen.queryByText('child-0')).not.toBeInTheDocument()
  await waitFor(() =>
    expect(api.historyAttachmentItems).toHaveBeenLastCalledWith({
      selection: { jobId: 'job', viewId: undefined, position: 4, blockIndex: 0 },
      cursor: 10,
    })
  )
})
