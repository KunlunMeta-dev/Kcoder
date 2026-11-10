import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { animatePageSurface } from './pageTransitionAnimation'
import { PageTransitionController } from './pageTransitions'

type FakeAnimation = Animation & { element: HTMLElement; cancelled: boolean }
const started: FakeAnimation[] = []

function installAnimate(element: HTMLElement) {
  element.getClientRects = () => [{}] as unknown as DOMRectList
  element.animate = vi.fn(() => {
    const listeners: Array<() => void> = []
    let resolve: () => void = () => {}
    const animation = {
      element,
      cancelled: false,
      playState: 'running',
      finished: new Promise<void>(done => {
        resolve = done
      }),
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'cancel') listeners.push(listener)
      },
      cancel() {
        this.cancelled = true
        this.playState = 'idle'
        listeners.forEach(listener => listener())
        resolve()
      },
    } as unknown as FakeAnimation
    started.push(animation)
    return animation
  }) as unknown as HTMLElement['animate']
}

function nested() {
  const outer = document.createElement('div')
  const inner = document.createElement('div')
  outer.appendChild(inner)
  document.body.appendChild(outer)
  installAnimate(outer)
  installAnimate(inner)
  return { outer, inner }
}

afterEach(() => {
  started.forEach(animation => animation.cancel())
  started.length = 0
  document.body.innerHTML = ''
})

describe('page surface transitions', () => {
  test('a surface inside a fading ancestor does not start a second fade', () => {
    const { outer, inner } = nested()
    animatePageSurface(outer)
    animatePageSurface(inner)
    expect(started.map(animation => animation.element)).toEqual([outer])
  })

  test('an ancestor takes over from a fading descendant instead of multiplying', () => {
    const { outer, inner } = nested()
    animatePageSurface(inner)
    animatePageSurface(outer)
    expect(started).toHaveLength(2)
    expect(started[0].element).toBe(inner)
    expect(started[0].cancelled).toBe(true)
    expect(started[1].element).toBe(outer)
    expect(started[1].cancelled).toBe(false)
  })

  test('re-selecting the current tab is not a transition; selecting another tab is', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      render(<PageTransitionController />)
      const page = document.createElement('div')
      page.setAttribute('data-studio-page-content', 'true')
      const tablist = document.createElement('div')
      tablist.setAttribute('role', 'tablist')
      const current = document.createElement('button')
      current.setAttribute('role', 'tab')
      current.setAttribute('aria-selected', 'true')
      const other = document.createElement('button')
      other.setAttribute('role', 'tab')
      other.setAttribute('aria-selected', 'false')
      tablist.append(current, other)
      page.appendChild(tablist)
      document.body.appendChild(page)
      installAnimate(page)

      act(() => {
        current.click()
        vi.runAllTimers()
      })
      expect(started).toHaveLength(0)

      act(() => {
        other.click()
        vi.runAllTimers()
      })
      expect(started.map(animation => animation.element)).toEqual([page])
    } finally {
      vi.useRealTimers()
    }
  })
})
