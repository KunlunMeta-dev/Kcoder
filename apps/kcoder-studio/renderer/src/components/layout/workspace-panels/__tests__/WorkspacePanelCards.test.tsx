import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import '@/i18n'
import { PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS } from '@/components/ui/page-content'
import { WorkspacePanelCards } from '../WorkspacePanelCards'

describe('WorkspacePanelCards launcher column', () => {
  test('uses the shared widened page column instead of a local 48rem cap', () => {
    render(<WorkspacePanelCards />)

    const launcher = screen.getByTestId('workspace-tool-launcher')
    const column = launcher.firstElementChild
    expect(column).toHaveClass(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS, 'mx-auto')
    expect(column).not.toHaveClass('max-w-3xl')
  })
})
