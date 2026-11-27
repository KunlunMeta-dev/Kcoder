import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { HistoricalSearch } from './HistoricalSearch'
import type { useMigrationTranscript } from '@/kcoder/useMigrationTranscript'
const { read, body } = vi.hoisted(() => ({ read: vi.fn(), body: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({
  createMigrationApi: () => ({ historySearch: read }),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ content, historical }: { content: string; historical?: boolean }) => (
    <div data-testid="search-readonly" data-historical={historical}>
      {content}
    </div>
  ),
}))
const block = {
  index: 15,
  kind: 'text',
  preview: null,
  sourceBytes: 100,
  decodedBytes: null,
  bodyAvailable: true,
  callId: null,
  name: null,
  namespace: null,
  sourceType: null,
  outcome: null,
}
const hit = {
  position: 7,
  record: 30,
  block,
  before: 'before ',
  matched: 'needle',
  after: ' after',
  bodyCursor: 'authenticated-fragment',
}
const model = { scope: 'selected', text: body } as unknown as ReturnType<
  typeof useMigrationTranscript
>
beforeEach(() => {
  vi.resetAllMocks()
  body.mockResolvedValue({
    text: 'Decoded original body',
    nextCursor: null,
    sourceBytes: 100,
    decodedBytes: 98,
    encoding: 'json_string',
  })
  read.mockResolvedValue({
    items: [hit],
    nextCursor: null,
    scannedRecords: 40,
    totalRecords: 40,
    processedBytes: 1000,
    unsupportedBlocks: 0,
    excludedBlocks: 1,
  })
})
test('search renders snippets as text and opens only the signed original body after a click', async () => {
  render(
    <HistoricalSearch
      deviceId="target"
      workspacePath="/owned"
      jobId="job"
      viewId="view"
      isCurrent={() => true}
      model={model}
    />
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
  fireEvent.click(screen.getByRole('button', { name: 'search.find' }))
  await screen.findByText('needle')
  expect(body).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('needle'))
  await screen.findByText('Decoded original body')
  expect(body).toHaveBeenCalledExactlyOnceWith(
    7,
    15,
    'authenticated-fragment',
    expect.any(AbortSignal)
  )
  expect(screen.getByTestId('search-readonly')).toHaveAttribute('data-historical', 'true')
})
test('an unsupported or incomplete scope never produces a fake no-matches result', async () => {
  read.mockRejectedValue(new Error('migration_history_search_update_required'))
  render(<HistoricalSearch deviceId="target" jobId="job" isCurrent={() => true} model={model} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
  fireEvent.click(screen.getByRole('button', { name: 'search.find' }))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'errors.migration_history_search_update_required'
    )
  )
  expect(screen.queryByText('search.empty')).not.toBeInTheDocument()
  expect(body).not.toHaveBeenCalled()
})
