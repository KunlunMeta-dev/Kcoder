import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
const { widget, visualization, mermaid, open } = vi.hoisted(() => ({widget:vi.fn(), visualization:vi.fn(),mermaid:vi.fn(),open:vi.fn()}))
vi.mock('./widgets/ConversationWidget', () => ({ConversationWidget:widget,DeferredWidgetNotice:() => null}))
vi.mock('./CodexInlineVisualizationHost', () => ({CodexInlineVisualizationHost:visualization}))
vi.mock('./MarkdownMermaidBlock', () => ({MarkdownMermaidBlock:mermaid,MermaidErrorFallback:() => null}))
vi.mock('@/lib/external-links', () => ({openExternalUrl:open}))
beforeEach(() => vi.clearAllMocks())

test('historical rich text retains ordinary prose but never activates widgets, images, local files or raw HTML', () => {
  const onOpenFile=vi.fn()
  const content='# Historical heading\n\n**Preserved text**\n\n[Old file](/private/file.txt) [Old site](https://example.invalid)\n\n![Old image](https://example.invalid/image.png)\n\n::kcoder-widget{widget_id="source-widget" revision=1}\n\n<iframe src="https://example.invalid/frame"></iframe><img src="https://example.invalid/raw.png">'
  const {container}=render(<AssistantMarkdown content={content} historical onOpenFile={onOpenFile} />)
  expect(screen.getByRole('heading',{name:'Historical heading'})).toBeInTheDocument()
  expect(screen.getByText('Preserved text',{selector:'strong'})).toBeInTheDocument()
  expect(container.querySelectorAll('a,img,iframe,video,audio')).toHaveLength(0)
  expect(container.textContent).toContain('source-widget')
  fireEvent.click(screen.getByText('Old file'))
  fireEvent.click(screen.getByText('Old site'))
  expect(onOpenFile).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled()
  expect(widget).not.toHaveBeenCalled();expect(visualization).not.toHaveBeenCalled()
})

test('historical Mermaid remains readable source and the history flag participates in memoization', () => {
  const {container,rerender}=render(<AssistantMarkdown content={'```mermaid\ngraph TD\nA-->B\n```'} historical />)
  expect(container.textContent).toContain('graph TD')
  expect(mermaid).not.toHaveBeenCalled()
  const directive='::kcoder-widget{widget_id="source-widget" revision=1}'
  rerender(<AssistantMarkdown content={directive} />)
  expect(widget).toHaveBeenCalled()
  widget.mockClear()
  rerender(<AssistantMarkdown content={directive} historical />)
  expect(container.textContent).toContain(directive)
  expect(widget).not.toHaveBeenCalled()
})
