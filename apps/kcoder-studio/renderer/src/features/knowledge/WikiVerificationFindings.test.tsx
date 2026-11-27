import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { knowledgeApi, type WikiVerificationFinding } from '@/kcoder/knowledgeApi'
import { WikiVerificationFindings } from './WikiVerificationFindings'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
  }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { findings: vi.fn(), decideFinding: vi.fn() },
}))

const finding: WikiVerificationFinding = {
  findingId: 'f1',
  pageId: 'page',
  revisionId: 'rev-1',
  jobId: 'job',
  verdict: 'unsupported',
  code: 'wiki_support_unsupported',
  firstLine: 3,
  lastLine: 4,
  bodyHash: 'hash',
  current: true,
  createdAtMs: 1,
}

function renderPage(overrides: Partial<Parameters<typeof WikiVerificationFindings>[0]> = {}) {
  const props = {
    serverId: 'target',
    libraryId: 'wiki',
    scope: { pageId: 'page', expectedRevision: 'rev-1' },
    isCurrent: () => true,
    canDecide: true,
    onDecided: vi.fn(),
    onPageChanged: vi.fn(),
    ...overrides,
  }
  render(<WikiVerificationFindings {...props} />)
  return props
}

// Model-independent decision flow; the host fixture does not prove verification quality.
describe('Wiki verification findings', () => {
  afterEach(() => vi.clearAllMocks())

  test('confirm sends the displayed revision with a stable request key', async () => {
    vi.mocked(knowledgeApi.findings).mockResolvedValue({ items: [finding], nextAfterId: null })
    vi.mocked(knowledgeApi.decideFinding).mockResolvedValue({ ...finding, decision: 'confirmed' })
    const props = renderPage()
    expect(await screen.findByTestId('wiki-finding-f1')).toHaveTextContent(
      'verification.verdict.unsupported'
    )
    expect(knowledgeApi.findings).toHaveBeenCalledWith('target', 'wiki', {
      pageId: 'page',
      jobId: undefined,
      afterId: undefined,
    })
    fireEvent.click(screen.getByTestId('wiki-finding-confirm-f1'))
    await waitFor(() => expect(props.onDecided).toHaveBeenCalled())
    const [, , target, revision, decision, key] = vi.mocked(knowledgeApi.decideFinding).mock
      .calls[0]
    expect(target).toBe(finding)
    expect(revision).toBe('rev-1')
    expect(decision).toBe('confirm')
    expect(key).toMatch(/^finding:confirm:/)
    expect(screen.queryByTestId('wiki-finding-f1')).toBeNull()
    expect(screen.getByTestId('wiki-findings-notice')).toHaveTextContent('findings.confirmed')
  })

  test('a changed page reloads and explains instead of retrying', async () => {
    vi.mocked(knowledgeApi.findings).mockResolvedValue({ items: [finding], nextAfterId: null })
    vi.mocked(knowledgeApi.decideFinding).mockRejectedValue(
      new Error('Wiki page changed; reload it before deciding this finding')
    )
    const props = renderPage()
    fireEvent.click(await screen.findByTestId('wiki-finding-dismiss-f1'))
    await waitFor(() => expect(props.onPageChanged).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('wiki-findings-notice')).toHaveTextContent('findings.pageChanged')
    await waitFor(() => expect(knowledgeApi.findings).toHaveBeenCalledTimes(2))
    expect(knowledgeApi.decideFinding).toHaveBeenCalledTimes(1)
    expect(props.onDecided).not.toHaveBeenCalled()
  })

  test('an idempotency conflict reloads; an unknown failure keeps the key for an explicit retry', async () => {
    vi.mocked(knowledgeApi.findings).mockResolvedValue({ items: [finding], nextAfterId: null })
    vi.mocked(knowledgeApi.decideFinding).mockRejectedValueOnce(new Error('connection lost'))
    renderPage()
    fireEvent.click(await screen.findByTestId('wiki-finding-confirm-f1'))
    expect(await screen.findByText(/connection lost/)).toBeInTheDocument()
    expect(knowledgeApi.decideFinding).toHaveBeenCalledTimes(1)
    vi.mocked(knowledgeApi.decideFinding).mockRejectedValueOnce(new Error('idempotency conflict'))
    await waitFor(() => expect(screen.getByTestId('wiki-finding-confirm-f1')).toBeEnabled())
    fireEvent.click(screen.getByTestId('wiki-finding-confirm-f1'))
    await waitFor(() =>
      expect(screen.getByTestId('wiki-findings-notice')).toHaveTextContent('findings.conflict')
    )
    const calls = vi.mocked(knowledgeApi.decideFinding).mock.calls
    expect(calls).toHaveLength(2)
    // The same decision retried by the user reuses its original key.
    expect(calls[1][5]).toBe(calls[0][5])
    await waitFor(() => expect(knowledgeApi.findings).toHaveBeenCalledTimes(2))
    // After a conflict the key is discarded; a new decision uses a fresh key.
    vi.mocked(knowledgeApi.decideFinding).mockResolvedValueOnce({
      ...finding,
      decision: 'dismissed',
    })
    await waitFor(() => expect(screen.getByTestId('wiki-finding-dismiss-f1')).toBeEnabled())
    fireEvent.click(screen.getByTestId('wiki-finding-dismiss-f1'))
    await waitFor(() => expect(knowledgeApi.decideFinding).toHaveBeenCalledTimes(3))
    expect(calls[2][5]).not.toBe(calls[0][5])
    expect(calls[2][4]).toBe('dismiss')
  })

  test('job scope decides against each finding revision and labels pages', async () => {
    vi.mocked(knowledgeApi.findings).mockResolvedValue({
      items: [{ ...finding, revisionId: 'rev-9' }],
      nextAfterId: 'f1',
    })
    vi.mocked(knowledgeApi.decideFinding).mockResolvedValue(finding)
    renderPage({ scope: { jobId: 'job' }, pageTitles: { page: 'Protocol page' } })
    expect(await screen.findByTestId('wiki-finding-f1')).toHaveTextContent('Protocol page')
    expect(screen.getByTestId('wiki-findings-more')).toBeEnabled()
    fireEvent.click(screen.getByTestId('wiki-finding-confirm-f1'))
    await waitFor(() => expect(knowledgeApi.decideFinding).toHaveBeenCalled())
    expect(vi.mocked(knowledgeApi.decideFinding).mock.calls[0][3]).toBe('rev-9')
  })

  test('decisions stay disabled without organization permission', async () => {
    vi.mocked(knowledgeApi.findings).mockResolvedValue({ items: [finding], nextAfterId: null })
    renderPage({ canDecide: false })
    expect(await screen.findByTestId('wiki-finding-confirm-f1')).toBeDisabled()
    expect(screen.getByTestId('wiki-finding-dismiss-f1')).toBeDisabled()
  })
})
