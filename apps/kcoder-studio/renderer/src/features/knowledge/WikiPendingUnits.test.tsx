import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { knowledgeApi, type WikiPendingUnit } from '@/kcoder/knowledgeApi'
import { WikiPendingUnits } from './WikiPendingUnits'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
    i18n: { language: 'zh-CN' },
  }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { pendingUnits: vi.fn(), organizePending: vi.fn() },
}))

const unit = (pendingId: string, overrides: Partial<WikiPendingUnit> = {}): WikiPendingUnit => ({
  pendingId,
  jobId: 'job',
  sourceId: 'source',
  sourceRevision: 'rev',
  unitId: `unit-${pendingId}`,
  chunkIds: ['c1'],
  firstLine: 10,
  lastLine: 20,
  reasonCode: 'wiki_organization_unit_unplaced',
  status: 'open',
  createdAtMs: 1,
  ...overrides,
})

function renderUnits(overrides: Partial<Parameters<typeof WikiPendingUnits>[0]> = {}) {
  const props = {
    serverId: 'target',
    libraryId: 'wiki',
    isCurrent: () => true,
    sources: [{ sourceId: 'source', revisionId: 'rev', title: 'Manual', bodyHash: 'h' }],
    canOrganize: true,
    refreshSignal: 0,
    onSupportChange: vi.fn(),
    onJobStarted: vi.fn(),
    onShowJob: vi.fn(),
    ...overrides,
  }
  const view = render(<WikiPendingUnits {...props} />)
  return { props, ...view }
}

// UI/RPC orchestration only; fixtures do not prove organization quality.
describe('Wiki pending units', () => {
  afterEach(() => vi.clearAllMocks())

  test('older targets render nothing and report no support', async () => {
    vi.mocked(knowledgeApi.pendingUnits).mockResolvedValue({
      supported: false,
      items: [],
      nextAfterId: null,
    })
    const { props, container } = renderUnits()
    await waitFor(() => expect(props.onSupportChange).toHaveBeenCalledWith(false))
    expect(container).toBeEmptyDOMElement()
    expect(knowledgeApi.organizePending).not.toHaveBeenCalled()
  })

  test('organizes only after an explicit selection and never auto-retries', async () => {
    vi.mocked(knowledgeApi.pendingUnits).mockResolvedValue({
      items: [
        unit('p1'),
        unit('p2'),
        unit('other', { sourceId: 'other-source', sourceRevision: 'r2' }),
        unit('old', { sourceRevision: 'stale' }),
      ],
      nextAfterId: null,
    })
    vi.mocked(knowledgeApi.organizePending).mockRejectedValueOnce(new Error('connection lost'))
    const { props } = renderUnits()
    expect(await screen.findByTestId('wiki-pending-units')).toHaveTextContent(
      'wiki_organization_unit_unplaced'
    )
    await waitFor(() => expect(props.onSupportChange).toHaveBeenCalledWith(true))
    expect(knowledgeApi.organizePending).not.toHaveBeenCalled()
    expect(screen.getByTestId('wiki-pending-organize')).toBeDisabled()
    // A unit of an older source revision cannot be organized.
    expect(screen.getByTestId('wiki-pending-old-select')).toBeDisabled()
    expect(screen.getByTestId('wiki-pending-old')).toHaveTextContent('pendingUnits.sourceChanged')
    fireEvent.click(screen.getByTestId('wiki-pending-p1-select'))
    // One request covers one source revision.
    expect(screen.getByTestId('wiki-pending-other-select')).toBeDisabled()
    fireEvent.click(screen.getByTestId('wiki-pending-p2-select'))
    fireEvent.click(screen.getByTestId('wiki-pending-organize'))
    expect(await screen.findByText(/connection lost/)).toBeInTheDocument()
    expect(knowledgeApi.organizePending).toHaveBeenCalledTimes(1)
    const first = vi.mocked(knowledgeApi.organizePending).mock.calls[0]
    expect(first.slice(0, 3)).toEqual(['target', 'wiki', ['p1', 'p2']])
    expect(first[4]).toBe('zh-CN')
    vi.mocked(knowledgeApi.organizePending).mockResolvedValueOnce({
      id: 'job-2',
      sourceId: 'source',
      status: 'queued',
      afterChunk: 0,
    })
    vi.mocked(knowledgeApi.pendingUnits).mockResolvedValue({
      items: [unit('p1', { status: 'organizing', organizeJobId: 'job-2' })],
      nextAfterId: null,
    })
    fireEvent.click(screen.getByTestId('wiki-pending-organize'))
    await waitFor(() => expect(props.onJobStarted).toHaveBeenCalled())
    // The explicit retry of the identical selection reuses its request key.
    expect(vi.mocked(knowledgeApi.organizePending).mock.calls[1][3]).toBe(first[3])
    expect(await screen.findByTestId('wiki-pending-p1')).toHaveAttribute('data-state', 'organizing')
    fireEvent.click(screen.getByTestId('wiki-pending-p1-job'))
    expect(props.onShowJob).toHaveBeenCalledWith('job-2')
    fireEvent.click(screen.getByTestId('wiki-pending-show-job'))
    expect(props.onShowJob).toHaveBeenLastCalledWith('job-2')
  })

  test('handled units are listed only on request', async () => {
    vi.mocked(knowledgeApi.pendingUnits).mockResolvedValue({
      items: [unit('p1')],
      nextAfterId: null,
    })
    renderUnits()
    fireEvent.click(await screen.findByTestId('wiki-pending-include-closed'))
    await waitFor(() =>
      expect(knowledgeApi.pendingUnits).toHaveBeenLastCalledWith('target', 'wiki', {
        includeClosed: true,
        afterId: undefined,
      })
    )
  })
})
