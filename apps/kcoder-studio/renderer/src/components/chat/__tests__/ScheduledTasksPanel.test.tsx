import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import '@/i18n'
import { PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS } from '@/components/ui/page-content'
import { ScheduledTasksPanel } from '../ScheduledTasksPanel'

describe('ScheduledTasksPanel column', () => {
  test('uses the shared widened page column instead of a local 48rem cap', () => {
    render(<ScheduledTasksPanel runtimeWork={null} />)

    // The shared page header sits above the scrolling gutter; the content column is its child.
    const column = screen
      .getByTestId('scheduled-tasks-panel')
      .querySelector('.studio-page-gutter')?.firstElementChild
    expect(column).toHaveClass(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS, 'mx-auto')
    expect(column).not.toHaveClass('max-w-3xl')
  })
})
