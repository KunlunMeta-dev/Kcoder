import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
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
