import { render, screen, waitFor } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { expect, test } from 'vitest'
import { RetainedPage } from './retainedPages'
import { useRetainedPageActive } from './retainedPageState'

function Activity() {
  return <output data-testid="nested-active">{String(useRetainedPageActive())}</output>
}

test('an open child page inherits its hidden parent activity', () => {
  const view = render(
    <RetainedPage open={false}><RetainedPage open><Activity /></RetainedPage></RetainedPage>
  )
  expect(screen.getByTestId('nested-active')).toHaveTextContent('false')
  view.rerender(
    <RetainedPage open><RetainedPage open><Activity /></RetainedPage></RetainedPage>
  )
  expect(screen.getByTestId('nested-active')).toHaveTextContent('true')
})

const originalDisplay = (node: HTMLDivElement | null) => node?.style.setProperty('display', 'grid', 'important')
function NestedPortals({ outer, inner, show = true }: { outer: boolean; inner: boolean; show?: boolean }) {
  return <RetainedPage open={outer}>
    <RetainedPage open={inner}>
      {show && createPortal(<div ref={originalDisplay} data-testid="nested-dialog">Original dialog</div>, document.body)}
    </RetainedPage>
  </RetainedPage>
}

test('reopening a parent does not release its hidden child portal', () => {
  const view = render(<NestedPortals outer={false} inner={false} />)
  const dialog = screen.getByTestId('nested-dialog')
  expect(dialog).not.toBeVisible()
  view.rerender(<NestedPortals outer inner={false} />)
  expect(dialog).not.toBeVisible()
  view.rerender(<NestedPortals outer inner />)
  expect(dialog).toBeVisible()
  expect(dialog.style.display).toBe('grid')
  expect(dialog.style.getPropertyPriority('display')).toBe('important')
})

test('late and reinserted portals stay hidden through nested visibility changes', async () => {
  const view = render(<NestedPortals outer={false} inner={false} show={false} />)
  view.rerender(<NestedPortals outer={false} inner={false} />)
  const dialog = screen.getByTestId('nested-dialog')
  await waitFor(() => expect(dialog).not.toBeVisible())
  document.body.append(dialog)
  await Promise.resolve()
  view.rerender(<NestedPortals outer inner={false} />)
  expect(dialog).not.toBeVisible()
  view.rerender(<NestedPortals outer inner />)
  expect(dialog).toBeVisible()
})

test('hiding the parent takes over its child portal without making the child active', () => {
  const view = render(<NestedPortals outer inner={false} />)
  const dialog = screen.getByTestId('nested-dialog')
  expect(dialog).not.toBeVisible()
  view.rerender(<NestedPortals outer={false} inner />)
  expect(dialog).not.toBeVisible()
  view.rerender(<NestedPortals outer inner />)
  expect(dialog).toBeVisible()
  expect(dialog.style.getPropertyPriority('display')).toBe('important')
})
