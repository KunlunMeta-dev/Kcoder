import { render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { animatePageSurface, usePageSurfaceTransition } from './pageTransitionAnimation'
import { RetainedPage } from './retainedPages'

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

  test('only a committed view change animates, retaining focus and scroll across unrelated updates', () => {
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true, writable: true,
      value: function (this: HTMLElement) {
        installAnimate(this)
        return this.animate([], {})
      },
    })
    function Surface({ tab, text }: { tab: string; text: string }) {
      const ref = usePageSurfaceTransition<HTMLDivElement>(tab)
      return <div ref={ref}><input aria-label="draft" defaultValue="keep" />{text}</div>
    }
    const view = (open: boolean, tab: string, text: string) => (
      <RetainedPage open={open}><Surface tab={tab} text={text} /></RetainedPage>
    )
    try {
      const rendered = render(view(true, 'one', 'first'))
      const input = rendered.getByRole('textbox')
      const panel = input.parentElement!
      input.focus()
      panel.scrollTop = 31
      rendered.rerender(view(true, 'one', 'streamed text'))
      expect(started.map(a => a.element)).toEqual([panel])
      rendered.rerender(view(true, 'two', 'another view'))
      expect(started).toHaveLength(2)
      expect(started[0].cancelled).toBe(true)
      expect(rendered.getByRole('textbox')).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(panel.scrollTop).toBe(31)
      rendered.rerender(view(false, 'two', 'hidden'))
      rendered.rerender(view(false, 'three', 'background update'))
      expect(started).toHaveLength(2)
      expect(started[1].cancelled).toBe(true)
      rendered.rerender(view(true, 'three', 'back'))
      expect(started.map(a => a.element)).toEqual([panel, panel, panel])
      rendered.unmount()
    } finally {
      rects.mockRestore()
      if (original) Object.defineProperty(HTMLElement.prototype, 'animate', original)
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    }
  })

  test('the dialog owns its entrance even when it contains a page column', () => {
    const { outer, inner } = nested()
    outer.setAttribute('role', 'dialog')
    animatePageSurface(inner)
    expect(started).toHaveLength(0)
  })
})
