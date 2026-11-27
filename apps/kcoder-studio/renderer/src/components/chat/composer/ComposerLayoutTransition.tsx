import { Component, createRef, type ReactNode } from 'react'

interface Props {
  active: boolean
  scopeKey: string
  chromeKey: string
  children: ReactNode
}
interface Visual {
  selector: string
  node: HTMLElement
  copy: HTMLElement
  rect: DOMRect
}
interface Snapshot {
  form: HTMLElement
  rect: DOMRect
  visuals: Visual[]
}
const CONTEXT = '[data-testid="composer-project-context"]'
const SELECTORS = [
  CONTEXT,
  '[data-testid="execution-mode-button"]',
  '[data-testid="project-branch-button"]',
  '[data-testid="project-worktree-branch-button"]',
]
const TIMING = { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }

/** Preserve presentation across the draft/thread DOM handoff without retaining live controls. */
export class ComposerLayoutTransition extends Component<
  Props,
  Record<string, never>,
  Snapshot | null
> {
  private root = createRef<HTMLDivElement>()
  private animations = new Set<Animation>()

  private composer() {
    return this.root.current?.querySelector<HTMLElement>('[data-testid="project-chat-composer"]')
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (
      !this.props.active ||
      this.props.scopeKey !== previous.scopeKey ||
      this.props.chromeKey === previous.chromeKey
    )
      return null
    const composer = this.composer()
    const form = composer?.querySelector<HTMLElement>('[data-testid="project-chat-composer-form"]')
    if (!form || !form.getClientRects().length || typeof form.animate !== 'function') return null
    return {
      form,
      rect: form.getBoundingClientRect(),
      visuals: SELECTORS.flatMap(selector => {
        const node = composer?.querySelector<HTMLElement>(selector)
        return node && node.getClientRects().length
          ? [
              {
                selector,
                node,
                copy: node.cloneNode(true) as HTMLElement,
                rect: node.getBoundingClientRect(),
              },
            ]
          : []
      }),
    }
  }

  private cancel() {
    for (const animation of this.animations) animation.cancel()
    this.animations.clear()
  }

  private animate(node: HTMLElement, frames: Keyframe[], remove?: () => void) {
    try {
      const animation = node.animate(frames, TIMING)
      this.animations.add(animation)
      const finish = () => {
        this.animations.delete(animation)
        remove?.()
      }
      void animation.finished.then(finish, finish)
    } catch {
      remove?.()
    }
  }

  private fadeOut({ copy, rect }: Visual) {
    // Copies are inert presentation, with no React handlers or accessible identities.
    for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
      for (const name of [
        'id',
        'data-testid',
        'aria-controls',
        'aria-labelledby',
        'aria-describedby',
      ])
        node.removeAttribute(name)
    }
    copy.inert = true
    copy.setAttribute('aria-hidden', 'true')
    copy.dataset.composerExitVisual = 'true'
    Object.assign(copy.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      minHeight: '0',
      margin: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '40',
    })
    document.body.append(copy)
    this.animate(copy, [{ opacity: 1 }, { opacity: 0 }], () => copy.remove())
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    if (!this.props.active || previous.scopeKey !== this.props.scopeKey) {
      this.cancel()
      return
    }
    if (!snapshot) return
    const composer = this.composer()
    const form = composer?.querySelector<HTMLElement>('[data-testid="project-chat-composer-form"]')
    if (!form || !form.getClientRects().length) return
    const contextRemoved = snapshot.visuals.some(
      v => v.selector === CONTEXT && !composer?.querySelector(CONTEXT)
    )
    const removed = snapshot.visuals.filter(
      v => !composer?.querySelector(v.selector) && (!contextRemoved || v.selector === CONTEXT)
    )
    // A readiness update must not cut short a fade already in progress.
    if (!removed.length && snapshot.form === form) return
    this.cancel()
    for (const visual of removed) this.fadeOut(visual)
    const rect = form.getBoundingClientRect()
    const x = snapshot.rect.left - rect.left,
      y = snapshot.rect.top - rect.top
    if (snapshot.form !== form || Math.abs(x) > 0.5 || Math.abs(y) > 0.5)
      this.animate(form, [
        { transform: `translate(${x}px, ${y}px)`, opacity: 0.85 },
        { transform: 'translate(0, 0)', opacity: 1 },
      ])
  }

  componentWillUnmount() {
    this.cancel()
  }

  render() {
    return (
      <div ref={this.root} className="contents">
        {this.props.children}
      </div>
    )
  }
}
