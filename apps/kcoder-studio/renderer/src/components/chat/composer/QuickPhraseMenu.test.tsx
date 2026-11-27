import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { QuickPhraseMenu } from './QuickPhraseMenu'

const appPreferenceMocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/hooks/useQuickPhrases', () => ({
  useQuickPhrases: () => [
    { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
    { id: 'plan', title: '制定计划', content: '制定实施计划', mode: 'plan' },
    {
      id: 'stash-images',
      title: '两张图片',
      content: '',
      mode: 'normal',
      attachmentPaths: ['/tmp/one.png', '/tmp/two.jpg'],
    },
  ],
}))

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))

vi.mock('@/host/appPreferences', () => ({
  getAppPreferences: appPreferenceMocks.get,
  updateAppPreferences: appPreferenceMocks.update,
}))

describe('QuickPhraseMenu', () => {
  test('Escape closes only this menu and restores its trigger focus', () => {
    const parentKeyDown = vi.fn()
    render(<div onKeyDown={parentKeyDown}><QuickPhraseMenu onSelect={vi.fn()} /></div>)
    const trigger = screen.getByTestId('quick-phrase-button')
    fireEvent.click(trigger)
    const accepted = fireEvent.keyDown(screen.getByTestId('quick-phrase-search-input'), { key: 'Escape' })
    expect(accepted).toBe(false)
    expect(parentKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByTestId('quick-phrase-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  test('selects a phrase with the mouse', () => {
    const onSelect = vi.fn()
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    fireEvent.click(screen.getByTestId('quick-phrase-option-plan'))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan' }))
    expect(screen.queryByTestId('quick-phrase-menu')).not.toBeInTheDocument()
  })

  test('uses subdued regular text for the trigger and menu options', () => {
    render(<QuickPhraseMenu onSelect={vi.fn()} />)

    expect(screen.getByTestId('quick-phrase-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )

    fireEvent.click(screen.getByTestId('quick-phrase-button'))

    expect(screen.getByTestId('quick-phrase-menu')).toHaveClass('text-text-primary')
    expect(screen.getByText('总结进展')).toHaveClass('font-normal')
  })

  test('filters and selects a phrase with the keyboard', () => {
    const onSelect = vi.fn()
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    const search = screen.getByTestId('quick-phrase-search-input')
    fireEvent.change(search, { target: { value: '计划' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan' }))
  })

  test('renders attachment stashes in a horizontal tray with hover preview', () => {
    render(<QuickPhraseMenu onSelect={vi.fn()} />)
    fireEvent.click(screen.getByTestId('quick-phrase-button'))

    const stash = screen.getByTestId('quick-phrase-stash-stash-images')
    const tray = screen.getByTestId('quick-phrase-stash-tray')
    expect(tray).toContainElement(stash)
    expect(
      tray.compareDocumentPosition(screen.getByTestId('quick-phrase-option-summary')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(stash.querySelectorAll('img')).toHaveLength(0)

    fireEvent.pointerEnter(stash)
    expect(screen.getByTestId('quick-phrase-stash-preview')).toHaveTextContent('两张图片')
    expect(screen.getByTestId('quick-phrase-stash-preview').style.width).toBe('16rem')
    expect(screen.getByTestId('quick-phrase-stash-preview').style.maxWidth).toBe('100%')
  })

  test('keeps the menu inside a narrow composer boundary', async () => {
    render(
      <div data-testid="project-chat-composer" data-floating-menu-boundary="true">
        <QuickPhraseMenu onSelect={vi.fn()} />
      </div>
    )
    const boundary = screen.getByTestId('project-chat-composer')
    boundary.getBoundingClientRect = () =>
      ({ left: 500, right: 640, top: 600, bottom: 700, width: 140, height: 100 }) as DOMRect
    const anchor = screen.getByTestId('quick-phrase-button').parentElement!
    anchor.getBoundingClientRect = () =>
      ({ left: 510, right: 542, top: 650, bottom: 682, width: 32, height: 32 }) as DOMRect

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    const menu = await screen.findByTestId('quick-phrase-menu')
    await waitFor(() => expect(menu.style.width).toBe('124px'))

    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(508)
    expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(632)
  })

  test('renders icon-only without label when iconOnly is true', () => {
    render(<QuickPhraseMenu iconOnly onSelect={vi.fn()} />)

    const button = screen.getByTestId('quick-phrase-button')
    expect(button).not.toHaveTextContent('快捷短语')
    expect(button.className).toContain('h-8')
    expect(button.className).toContain('w-8')
  })

  test('renders compact circular button without label when compact is true', () => {
    render(<QuickPhraseMenu compact onSelect={vi.fn()} />)

    const button = screen.getByTestId('quick-phrase-button')
    expect(button).not.toHaveTextContent('快捷短语')
    expect(button.className).toContain('h-11')
    expect(button.className).toContain('w-11')
  })

  test('deletes a stash without selecting it', async () => {
    const onSelect = vi.fn()
    appPreferenceMocks.get.mockResolvedValue({
      quickPhrases: [
        { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        {
          id: 'stash-images',
          title: '两张图片',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/one.png', '/tmp/two.jpg'],
        },
      ],
    })
    appPreferenceMocks.update.mockResolvedValue(undefined)
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    fireEvent.click(screen.getByTestId('quick-phrase-stash-delete-stash-images'))

    await waitFor(() =>
      expect(appPreferenceMocks.update).toHaveBeenCalledWith({
        quickPhrases: [
          { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        ],
      })
    )
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('clears every stash while preserving regular phrases', async () => {
    appPreferenceMocks.get.mockResolvedValue({
      quickPhrases: [
        { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        { id: 'stash-text', title: '文本', content: '暂存文本', mode: 'normal' },
        {
          id: 'stash-images',
          title: '图片',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/image.png'],
        },
      ],
    })
    appPreferenceMocks.update.mockResolvedValue(undefined)
    render(<QuickPhraseMenu onSelect={vi.fn()} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    const clearButton = screen.getByTestId('quick-phrase-stash-clear-button')
    expect(clearButton).toHaveClass('min-h-11', 'min-w-11', 'md:min-h-0', 'md:min-w-0')
    fireEvent.click(clearButton)

    await waitFor(() =>
      expect(appPreferenceMocks.update).toHaveBeenCalledWith({
        quickPhrases: [
          { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        ],
      })
    )
  })
})


test.each(['mouse', 'keyboard'])('old attachment phrases never silently insert incomplete content via %s', method => {
  appPreferenceMocks.update.mockClear()
  const onSelect = vi.fn()
  render(<QuickPhraseMenu onSelect={onSelect} />)
  fireEvent.click(screen.getByTestId('quick-phrase-button'))
  if (method === 'mouse') {
    fireEvent.click(screen.getByTestId('quick-phrase-stash-stash-images').querySelector('button')!)
  } else {
    const input = screen.getByTestId('quick-phrase-search-input')
    fireEvent.change(input, { target: { value: '两张图片' } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }
  expect(screen.getByTestId('quick-phrase-selection-error')).toHaveTextContent('当前草稿和已保存短语均已保留')
  expect(onSelect).not.toHaveBeenCalled()
  expect(appPreferenceMocks.update).not.toHaveBeenCalled()
  expect(screen.getByTestId('quick-phrase-menu')).toBeInTheDocument()
})
