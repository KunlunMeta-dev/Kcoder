import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { AssistantMarkdown } from '../AssistantMarkdown'
import { WidgetMessageBoundary } from './WidgetMessageBoundary'

vi.mock('../CodexInlineVisualizationHost', () => ({
  CodexInlineVisualizationHost: () => (
    <div data-testid="legacy-file-widget-host">File visualization</div>
  ),
}))

const fileDirective = '::codex-inline-vis{file=".codex/visualizations/diagram.html"}'

test('process Markdown cannot expand a file visualization even after the final reply is complete', () => {
  render(
    <WidgetMessageBoundary identity={{ terminal: true, active: false }}>
      <AssistantMarkdown content={fileDirective} variant="process" />
    </WidgetMessageBoundary>
  )
  expect(screen.getByTestId('widget-deferred-status')).toBeInTheDocument()
  expect(screen.queryByTestId('legacy-file-widget-host')).not.toBeInTheDocument()
})

test('streaming and failed message Markdown do not load file visualization hosts', () => {
  const { rerender } = render(
    <WidgetMessageBoundary identity={{ terminal: false, active: true }}>
      <AssistantMarkdown content={fileDirective} isStreaming />
    </WidgetMessageBoundary>
  )
  expect(screen.queryByTestId('legacy-file-widget-host')).not.toBeInTheDocument()
  rerender(
    <WidgetMessageBoundary identity={{ terminal: false, active: false }}>
      <AssistantMarkdown content={fileDirective} />
    </WidgetMessageBoundary>
  )
  expect(screen.getByTestId('widget-deferred-status')).toBeInTheDocument()
  expect(screen.queryByTestId('legacy-file-widget-host')).not.toBeInTheDocument()
})

test('completed final and standalone legacy Markdown retain their file visualization path', () => {
  const { rerender } = render(
    <WidgetMessageBoundary identity={{ terminal: true, active: false }}>
      <AssistantMarkdown content={fileDirective} />
    </WidgetMessageBoundary>
  )
  expect(screen.getByTestId('legacy-file-widget-host')).toBeInTheDocument()
  rerender(<AssistantMarkdown content={fileDirective} />)
  expect(screen.getByTestId('legacy-file-widget-host')).toBeInTheDocument()
})
