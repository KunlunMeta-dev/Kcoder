import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WikiFileExtraction } from './WikiFileExtraction'

// Model-independent presentation: visible warnings, expandable details, no invented metadata.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('Wiki extraction report presentation', () => {
  it('keeps support warnings visible while extraction metadata is collapsed', () => {
    const { container } = render(
      <WikiFileExtraction
        report={{
          format: 'pdf',
          textBytes: 12,
          chunkCount: 1,
          unit: 'page',
          extractedUnits: 1,
          totalUnits: 2,
          warnings: ['pdf_text_only', 'pdf_empty_pages'],
        }}
      />
    )
    expect(screen.getByText('extractionWarning.pdf_empty_pages')).toBeVisible()
    expect(screen.getByText('extractionWarning.pdf_text_only')).toBeVisible()
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })
  it('does not invent a report or pagination for old sources and unpaginated formats', () => {
    const { container, rerender } = render(<WikiFileExtraction />)
    expect(container).toBeEmptyDOMElement()
    rerender(
      <WikiFileExtraction
        report={{ format: 'docx', textBytes: 6, chunkCount: 1, warnings: ['docx_body_only'] }}
      />
    )
    expect(screen.getByText('extractionWarning.docx_body_only')).toBeVisible()
    expect(screen.queryByText('extractionUnit.page')).toBeNull()
  })
})
