import '@/i18n'
import { useLayoutEffect } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

const queued = vi.hoisted(() => ({ ignore: undefined as undefined | (() => void),
  escape: undefined as undefined | (() => void) }))
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...original, jsxDEV: (...args: Parameters<typeof original.jsxDEV>) => {
    const props = args[1] as Record<string, unknown>
    if (props?.['data-testid'] === 'request-user-input-ignore-button')
      queued.ignore = props.onClick as () => void
    if (args[0] === 'form') queued.escape = () => (props.onKeyDown as (event: unknown) => void)({
      key: 'Escape', preventDefault() {}, stopPropagation() {}, nativeEvent: {},
    })
    return original.jsxDEV(...args)
  } }
})

const payload = { requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn',
  appServerEpoch: 'epoch', questions: [{ id: 'item', question: 'Continue?', options: [] }] }
beforeEach(() => { queued.ignore = undefined; queued.escape = undefined })

const transitions = [false, true].flatMap(embedded => (['ignore', 'escape'] as const).flatMap(action =>
  ['unmount', 'replace-owner', 'disable', 'recover-connection'].map(transition => ({ embedded, action, transition }))))
it.each(transitions)('queued $action respects $transition commits (embedded=$embedded)', async ({ embedded, action, transition }) => {
    const ignore = vi.fn()
    function Host({ changed }: { changed: boolean }) {
      useLayoutEffect(() => { if (changed) retained?.() }, [changed])
      return <>{!(changed && transition === 'unmount') && <RequestUserInputCard
        payload={changed && transition === 'replace-owner' ? { ...payload, requestId: 8 } : payload}
        disabled={changed && transition === 'disable'}
        submissionEpoch={changed && transition === 'recover-connection' ? 1 : 0}
        embedded={embedded}
        onIgnore={ignore}
      />}</>
    }
    const view = render(<Host changed={false} />)
    const draft = screen.getByTestId('request-user-input-custom-item')
    fireEvent.change(draft, { target: { value: 'Keep this draft' } })
    const retained = queued[action]
    expect(retained).toBeTypeOf('function')
    await act(async () => view.rerender(<Host changed />))
    expect.soft(ignore, transition).not.toHaveBeenCalled()
    await act(async () => view.rerender(<Host changed={false} />))
    await act(async () => retained?.())
    expect.soft(ignore, `${transition} revisit`).not.toHaveBeenCalled()
    if (transition === 'disable' || transition === 'recover-connection')
      expect(draft).toHaveValue('Keep this draft')
    fireEvent.click(screen.getByTestId('request-user-input-ignore-button'))
    expect.soft(ignore, `${transition} current action`).toHaveBeenCalledOnce()
    view.unmount()
})

it.each([false, true])('queued ignore during submission preserves embedded=%s behavior', embedded => {
  const ignore = vi.fn()
  render(<RequestUserInputCard payload={payload} embedded={embedded} onIgnore={ignore}
    onSubmit={() => new Promise(() => undefined)} />)
  const retained = queued.ignore!
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  act(() => retained())
  // Embedded async questions can still be collapsed while their answer waits.
  expect(ignore).toHaveBeenCalledTimes(embedded ? 1 : 0)
})

it.each(['ignore', 'escape'] as const)('queued %s cannot call a replaced dismissal callback', action => {
  const previousIgnore = vi.fn()
  const currentIgnore = vi.fn()
  const view = render(<RequestUserInputCard payload={payload} embedded onIgnore={previousIgnore} />)
  const retained = queued[action]!
  expect(retained).toBeTypeOf('function')

  view.rerender(<RequestUserInputCard payload={payload} embedded onIgnore={currentIgnore} />)
  act(() => retained())
  expect(previousIgnore).not.toHaveBeenCalled()
  expect(currentIgnore).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  expect(currentIgnore).toHaveBeenCalledOnce()
})
