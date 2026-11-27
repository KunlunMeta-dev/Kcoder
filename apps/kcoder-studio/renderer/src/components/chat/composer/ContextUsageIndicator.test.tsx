import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ContextUsageIndicator } from './ContextUsageIndicator'

const usage = {
  total: { totalTokens: 500, inputTokens: 300, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
  last: { totalTokens: 500, inputTokens: 300, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
  modelContextWindow: 1000,
}

afterEach(async () => {
  vi.useRealTimers()
  await i18n.changeLanguage('zh-CN')
})

describe('ContextUsageIndicator layout', () => {
  test('debounces bursts for 250ms without starving updates beyond one second', () => {
    vi.useFakeTimers()
    const sample = (totalTokens: number) => ({ ...usage, last: { ...usage.last, totalTokens } })
    const view = render(<ContextUsageIndicator usage={usage} />)
    view.rerender(<ContextUsageIndicator usage={sample(600)} />)
    act(() => vi.advanceTimersByTime(150))
    view.rerender(<ContextUsageIndicator usage={sample(650)} />)
    act(() => vi.advanceTimersByTime(249))
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('已用 50%')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('已用 65%')

    for (const totalTokens of [700, 750, 800, 850, 900]) {
      view.rerender(<ContextUsageIndicator usage={sample(totalTokens)} />)
      expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('已用 65%')
      act(() => vi.advanceTimersByTime(200))
    }
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('已用 90%')
    view.rerender(<ContextUsageIndicator usage={sample(950)} />)
    view.rerender(<ContextUsageIndicator usage={sample(0)} />)
    expect(view.container).toBeEmptyDOMElement()
    act(() => vi.advanceTimersByTime(1000))
    expect(view.container).toBeEmptyDOMElement()
  })

  test.each([
    ['zh-CN', '已用 20%', '上下文用量'],
    ['en', '20% used', 'Context usage'],
  ])('shows only the icon with localized usage details in %s', async (language, label, title) => {
    await i18n.changeLanguage(language)
    render(<ContextUsageIndicator usage={{ ...usage, last: { ...usage.last, totalTokens: 200 } }} />)
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent(label)
    expect(screen.getByTestId('context-usage-button')).toHaveTextContent(/^$/)
    expect(screen.getByTestId('context-usage-tooltip')).toHaveTextContent(title)
  })

  test('stays hidden until valid usage arrives and hides again when it becomes unavailable', () => {
    const view = render(<ContextUsageIndicator />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ContextUsageIndicator usage={usage} />)
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('已用 50%')
    view.rerender(<ContextUsageIndicator usage={{ ...usage, modelContextWindow: 0 }} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ContextUsageIndicator usage={{ ...usage,
      last: { ...usage.last, totalTokens: 0 } }} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ContextUsageIndicator usage={{ ...usage,
      last: { ...usage.last, totalTokens: Number.NaN },
      total: { ...usage.total, totalTokens: Number.NaN } }} />)
    expect(view.container).toBeEmptyDOMElement()
  })

  test('keeps its tooltip and confirmation within a narrow composer pane', async () => {
    render(
      <div data-testid="project-chat-composer" data-floating-menu-boundary="true">
        <ContextUsageIndicator usage={usage} onCompactContext={vi.fn()} />
      </div>
    )

    const boundary = screen.getByTestId('project-chat-composer')
    boundary.getBoundingClientRect = () =>
      ({ left: 500, right: 640, top: 600, bottom: 700, width: 140, height: 100 }) as DOMRect
    const trigger = screen.getByTestId('context-usage-indicator')
    trigger.getBoundingClientRect = () =>
      ({ left: 510, right: 560, top: 650, bottom: 682, width: 50, height: 32 }) as DOMRect
    fireEvent(window, new Event('resize'))

    const tooltip = screen.getByTestId('context-usage-tooltip')
    await waitFor(() => expect(tooltip.style.width).toBe('124px'))

    fireEvent.click(screen.getByTestId('context-usage-button'))
    const confirm = await screen.findByTestId('compact-context-confirm-popover')
    await waitFor(() => expect(confirm.style.width).toBe('124px'))
    expect(Number.parseFloat(confirm.style.left)).toBeGreaterThanOrEqual(508)
    expect(Number.parseFloat(confirm.style.left) + Number.parseFloat(confirm.style.width)).toBeLessThanOrEqual(632)
  })
})
