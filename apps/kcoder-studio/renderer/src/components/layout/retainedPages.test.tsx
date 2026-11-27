import { render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RetainedPage } from './retainedPages'
import { useRetainedPageActive, useRetainedPages } from './retainedPageState'

let mounts = 0
const polls: string[] = []
const disposed: string[] = []
function Page({ id }: { id: string }) {
  const [mountId] = useState(() => ++mounts)
  const active = useRetainedPageActive()
  // Pages own clients in effects; hiding must not dispose them.
  useEffect(() => () => void disposed.push(id), [id])
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => polls.push(id), 1000)
    return () => clearInterval(timer)
  }, [id, active])
  return (
    <div data-testid={`page-${id}`} data-mount={mountId} data-active={String(active)}>
      {id}
    </div>
  )
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f']
function Layout({ current, limit }: { current: string; limit?: number }) {
  const pages = useRetainedPages(Object.fromEntries(IDS.map(id => [id, id === current])), limit)
  return (
    <>
      {IDS.map(id =>
        pages.retained(id) ? (
          <RetainedPage key={pages.mountKey(id)} open={id === current}>
            <Page id={id} />
          </RetainedPage>
        ) : null
      )}
    </>
  )
}

afterEach(() => {
  mounts = 0
  polls.length = 0
  disposed.length = 0
  window.history.replaceState(null, '', '/')
})

describe('retained workbench pages', () => {
  test('returning to a page reuses the mounted page instead of loading it again', () => {
    const view = render(<Layout current="a" />)
    const first = screen.getByTestId('page-a').dataset.mount
    view.rerender(<Layout current="b" />)
    const hidden = screen.getByTestId('page-a')
    expect(hidden.dataset.active).toBe('false')
    expect(hidden.parentElement?.hasAttribute('inert')).toBe(true)
    expect(hidden.parentElement?.style.display).toBe('none')
    view.rerender(<Layout current="a" />)
    expect(screen.getByTestId('page-a').dataset.mount).toBe(first)
    expect(screen.getByTestId('page-a').dataset.active).toBe('true')
    expect(screen.getByTestId('page-a').parentElement?.hasAttribute('inert')).toBe(false)
  })

  test('reopening with another deep link remounts the page', () => {
    window.history.replaceState(null, '', '/?deviceId=one')
    const view = render(<Layout current="a" />)
    const first = screen.getByTestId('page-a').dataset.mount
    view.rerender(<Layout current="b" />)
    window.history.replaceState(null, '', '/?deviceId=two')
    view.rerender(<Layout current="a" />)
    expect(screen.getByTestId('page-a').dataset.mount).not.toBe(first)
  })

  test('hiding a page keeps the resources its effects own', () => {
    const view = render(<Layout current="a" />)
    view.rerender(<Layout current="b" />)
    // StrictMode replays effects once on mount; count only later disposals.
    disposed.length = 0
    view.rerender(<Layout current="a" />)
    view.rerender(<Layout current="b" />)
    expect(disposed).toEqual([])
  })

  test('only the most recent hidden pages stay mounted', () => {
    const view = render(<Layout current="a" limit={2} />)
    for (const id of ['b', 'c', 'd']) view.rerender(<Layout current={id} limit={2} />)
    expect(screen.queryByTestId('page-a')).toBeNull()
    expect(screen.queryByTestId('page-b')).not.toBeNull()
    expect(screen.queryByTestId('page-c')).not.toBeNull()
    expect(screen.getByTestId('page-d').dataset.active).toBe('true')
  })

  test('a hidden page stops polling and resumes when shown, keeping its state', () => {
    vi.useFakeTimers()
    try {
      const view = render(<Layout current="a" />)
      const first = screen.getByTestId('page-a').dataset.mount
      act(() => vi.advanceTimersByTime(2000))
      expect(polls).toEqual(['a', 'a'])
      view.rerender(<Layout current="b" />)
      polls.length = 0
      act(() => vi.advanceTimersByTime(3000))
      expect(polls.filter(id => id === 'a')).toEqual([])
      view.rerender(<Layout current="a" />)
      polls.length = 0
      act(() => vi.advanceTimersByTime(1000))
      expect(polls).toEqual(['a'])
      expect(screen.getByTestId('page-a').dataset.mount).toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a dialog the page portalled into the body is hidden with the page', () => {
    const Dialog = ({ open }: { open: boolean }) => (
      <>
        <RetainedPage open={open}>
          {createPortal(<div data-testid="page-dialog">dialog</div>, document.body)}
        </RetainedPage>
        {createPortal(<div data-testid="shell-menu">menu</div>, document.body)}
      </>
    )
    const view = render(<Dialog open />)
    view.rerender(<Dialog open={false} />)
    expect(screen.getByTestId('page-dialog').style.display).toBe('none')
    expect(screen.getByTestId('shell-menu').style.display).toBe('')
    view.rerender(<Dialog open />)
    expect(screen.getByTestId('page-dialog').style.display).toBe('')
  })
})
