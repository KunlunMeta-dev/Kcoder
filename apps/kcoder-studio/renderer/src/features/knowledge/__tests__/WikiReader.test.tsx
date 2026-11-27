import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'
import { PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS } from '@/components/ui/page-content'
import { WikiReader } from '../WikiReader'

describe('WikiReader column', () => {
  test('reads in the shared widened page column instead of a local 48rem cap', () => {
    render(
      <WikiReader
        page={{
          revisionId: 'v1',
          humanEdited: false,
          draft: { pageId: 'p1', title: 'Overview', markdown: '# Overview\n\nBody', citations: [] },
        }}
        serverId="local"
        libraryId="wiki"
        sources={[]}
        isCurrent={() => true}
        onBack={vi.fn()}
        onUpdated={vi.fn()}
        canOrganize={false}
      />
    )

    const reader = screen.getByTestId('wiki-reader')
    expect(reader).toHaveClass(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS, 'mx-auto')
    expect(reader).not.toHaveClass('max-w-3xl')
  })
})

describe('WikiReader verification', () => {
  const base = {
    revisionId: 'v1',
    humanEdited: false,
    draft: {
      pageId: 'p1',
      title: 'Overview',
      markdown: '# Overview\n\nVerified claim\n\nUnsupported claim\n\nTail',
      citations: [],
    },
  }
  const renderReader = (page: WikiPage, onUpdated = vi.fn()) =>
    render(
      <WikiReader
        page={page}
        serverId="local"
        libraryId="wiki"
        sources={[]}
        isCurrent={() => true}
        onBack={vi.fn()}
        onUpdated={onUpdated}
        canOrganize
      />
    )
  afterEach(() => vi.restoreAllMocks())

  test('older targets without verification keep the plain reader', () => {
    renderReader(base)
    expect(screen.queryByTestId('wiki-verification-banner')).toBeNull()
    expect(screen.queryByTestId('wiki-verification-status')).toBeNull()
    expect(screen.queryByTestId('wiki-unverified-range')).toBeNull()
  })

  test('partial pages warn and highlight only the unverified body lines', () => {
    renderReader({
      ...base,
      verification: {
        status: 'partial',
        unverified: [{ firstLine: 5, lastLine: 5, verdict: 'unsupported' }],
      },
    })
    expect(screen.getByTestId('wiki-verification-banner')).toHaveAttribute('data-status', 'partial')
    const ranges = screen.getAllByTestId('wiki-unverified-range')
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toHaveAttribute('data-verdicts', 'unsupported')
    expect(ranges[0]).toHaveTextContent('Unsupported claim')
    expect(ranges[0]).not.toHaveTextContent('Verified claim')
    expect(ranges[0].getAttribute('title')).toMatch(/5/)
    expect(screen.queryByTestId('wiki-unverified-title')).toBeNull()
  })

  test('a title range marks the heading instead of the body', () => {
    renderReader({
      ...base,
      verification: {
        status: 'partial',
        unverified: [{ firstLine: 0, lastLine: 0, verdict: 'uncertain' }],
      },
    })
    expect(screen.getByTestId('wiki-unverified-title')).toHaveTextContent('Overview')
    expect(screen.queryByTestId('wiki-unverified-range')).toBeNull()
  })

  test.each(['verified', 'legacy', 'human_edited'] as const)(
    '%s pages show a status chip without a warning banner',
    status => {
      renderReader({ ...base, verification: { status, unverified: [] } })
      expect(screen.getByTestId('wiki-verification-status')).toHaveAttribute('data-status', status)
      expect(screen.queryByTestId('wiki-verification-banner')).toBeNull()
    }
  )

  test('a decision re-reads the page so highlights follow the open findings', async () => {
    vi.spyOn(knowledgeApi, 'findings').mockResolvedValue({
      items: [
        {
          findingId: 'f1',
          pageId: 'p1',
          revisionId: 'v1',
          jobId: 'job',
          verdict: 'unsupported',
          code: 'wiki_support_unsupported',
          firstLine: 5,
          lastLine: 5,
          bodyHash: 'h',
          current: true,
          createdAtMs: 1,
        },
      ],
      nextAfterId: null,
    })
    const decide = vi.spyOn(knowledgeApi, 'decideFinding').mockImplementation(async finding => ({
      ...(finding as never),
      decision: 'dismissed',
    }))
    const refreshed = { ...base, verification: { status: 'verified' as const, unverified: [] } }
    const read = vi.spyOn(knowledgeApi, 'page').mockResolvedValue(refreshed)
    const onUpdated = vi.fn()
    renderReader(
      {
        ...base,
        verification: {
          status: 'partial',
          unverified: [{ firstLine: 5, lastLine: 5, verdict: 'unsupported' }],
        },
      },
      onUpdated
    )
    fireEvent.click(screen.getByTestId('wiki-verification-findings-toggle'))
    fireEvent.click(await screen.findByTestId('wiki-finding-dismiss-f1'))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(refreshed))
    expect(decide.mock.calls[0][3]).toBe('v1')
    expect(read).toHaveBeenCalledWith('local', 'wiki', 'p1')
  })
})
