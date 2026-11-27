import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerToolbar } from './ComposerToolbar'

let resizeCallback: ResizeObserverCallback | null = null
vi.mock('./QuickPhraseMenu', () => ({
  QuickPhraseMenu: () => <button data-testid="quick-phrase-layout">phrases</button>,
}))
vi.mock('./ModelSelector', () => ({
  ModelSelector: () => <button data-testid="model-selector-button">model</button>,
}))
class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }
  observe() {}
  disconnect() {}
}
function StatefulAction() {
  const [active, setActive] = useState(false)
  return (
    <button data-testid="optional-action" aria-pressed={active} onClick={() => setActive(!active)}>
      Action
    </button>
  )
}

describe('ComposerToolbar', () => {
  afterEach(() => {
    resizeCallback = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps usage visible while running and discards delayed readings when the task changes', () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const usage = {
      total: { totalTokens: 500, inputTokens: 300, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
      last: { totalTokens: 500, inputTokens: 300, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
      modelContextWindow: 1000,
    }
    const props = {
      canSend: true,
      models: [],
      selectedModel: null,
      selectedModelOptions: {},
      isModelSelectionReady: true,
      onSelectModel: vi.fn(),
      onSelectModelOption: vi.fn(),
      onFileSelect: vi.fn(),
      onQuickPhraseSelect: vi.fn(),
      onSubmit: vi.fn(),
      onCompactContext: vi.fn(),
      contextUsageScopeKey: 'task-one',
    }
    const view = render(<ComposerToolbar {...props} contextUsage={usage} />)
    expect(screen.getByTestId('context-usage-indicator')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('context-usage-button'))
    expect(screen.getByTestId('compact-context-confirm-popover')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('context-usage-button'))

    view.rerender(<ComposerToolbar {...props} contextUsage={usage} isStreaming />)
    expect(screen.getByTestId('context-usage-indicator')).toBeInTheDocument()
    const latestUsage = { ...usage, last: { ...usage.last, totalTokens: 700 } }
    view.rerender(<ComposerToolbar {...props} contextUsage={latestUsage} isStreaming />)
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('50')
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('70')

    view.rerender(<ComposerToolbar {...props} contextUsage={latestUsage} />)
    expect(screen.getByTestId('context-usage-indicator')).toHaveAttribute(
      'aria-label', expect.stringContaining('70')
    )
    view.rerender(<ComposerToolbar {...props} contextUsage={{
      ...usage, last: { ...usage.last, totalTokens: 800 },
    }} isStreaming />)
    fireEvent.click(screen.getByTestId('context-usage-button'))
    view.rerender(<ComposerToolbar {...props} contextUsageScopeKey="task-two" contextUsage={{
      ...usage, last: { ...usage.last, totalTokens: 200 },
    }} isStreaming />)
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('20')
    expect(screen.queryByTestId('compact-context-confirm-popover')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('context-usage-percent')).toHaveTextContent('20')
    view.rerender(<ComposerToolbar {...props} contextUsage={{
      ...usage, last: { ...usage.last, totalTokens: 0 },
    }} />)
    expect(screen.queryByTestId('context-usage-indicator')).not.toBeInTheDocument()
  })

  it('uses measured space to remove labels before folding actions, without resetting control state', () => {
    let width = 1100
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const density = Number(this.closest('[data-density]')?.getAttribute('data-density') ?? 0)
      const measured =
        this.dataset.testid === 'composer-toolbar-actions'
          ? [700, 350, 230, 100][density]
          : this.dataset.testid === 'composer-toolbar-model-controls'
            ? 100
            : width
      return {
        width: measured,
        height: 32,
        top: 0,
        right: measured,
        bottom: 32,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }
    })
    render(
      <ComposerToolbar
        canSend
        models={[]}
        selectedModel={null}
        selectedModelOptions={{}}
        isModelSelectionReady
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onSubmit={vi.fn()}
        modeStatus={<StatefulAction />}
      />
    )
    const toolbar = screen.getByTestId('composer-toolbar')
    const action = screen.getByTestId('optional-action')
    fireEvent.click(action)
    for (const [nextWidth, density] of [
      [1100, 0],
      [610, 1],
      [390, 2],
      [300, 3],
      [1100, 0],
    ]) {
      width = nextWidth
      act(() => resizeCallback?.([], {} as ResizeObserver))
      expect(toolbar).toHaveAttribute('data-density', String(density))
      expect(toolbar).toHaveAttribute('data-compact', density > 0 ? 'true' : 'false')
      expect(screen.getByTestId('optional-action')).toBe(action)
      expect(action).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('model-selector-button')).toBeEnabled()
      expect(screen.getByTestId('send-message-button')).toBeEnabled()
      if (density >= 2)
        expect(screen.getByTestId('composer-more-button')).toHaveAttribute(
          'popoverTarget',
          action.closest('[popover]')!.id
        )
      else expect(screen.queryByTestId('composer-more-button')).toBeNull()
    }
  })
})
