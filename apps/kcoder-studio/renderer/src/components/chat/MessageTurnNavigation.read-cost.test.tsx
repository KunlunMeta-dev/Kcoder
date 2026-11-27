import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageTurnNavigation } from './MessageTurnNavigation'

afterEach(() => vi.useRealTimers())

test('navigation reuses current previews across geometry and hover updates, then projects new stream and history inputs', async () => {
  vi.useFakeTimers()
  let contentReads = 0
  const messages: WorkbenchMessage[] = Array.from({ length: 24 }, (_, index) => [
    { id: `user-${index}`, role: 'user' as const, status: 'done' as const,
      createdAt: '2026-11-24T00:00:00Z', runtimeMessageIndex: index * 2,
      get content() { contentReads++; return `Prompt ${index}` } },
    { id: `assistant-${index}`, role: 'assistant' as const, status: 'done' as const,
      createdAt: '2026-11-24T00:00:00Z', runtimeMessageIndex: index * 2 + 1,
      get content() { contentReads++; return `Response ${index}` } },
  ]).flat()
  const turnNavigation = Array.from({ length: 24 }, (_, index) => ({
    id: `user-${index}`, turnIndex: index, messageIndex: index * 2,
    promptPreview: `Stored prompt ${index}`, responsePreview: `Stored response ${index}`,
    cursor: `offset:${index * 2}`,
  }))
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  const view = (currentMessages = messages, navigation = turnNavigation) => <>
    <div ref={scrollRef}><div ref={contentRef}>
      {messages.filter(message => message.role === 'user').map(message =>
        <div key={message.id} data-message-id={message.id} />)}
    </div></div>
    <MessageTurnNavigation messages={currentMessages} turnNavigation={navigation}
      scrollRef={scrollRef} contentRef={contentRef} />
  </>
  const page = render(view())
  try {
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(24)
    contentReads = 0
    for (let index = 0; index < 40; index++) {
      fireEvent.resize(window)
      await act(async () => { await vi.runOnlyPendingTimersAsync() })
      const marker = screen.getAllByTestId('message-turn-navigation-marker')[index % 24]
      fireEvent.mouseEnter(marker.parentElement!)
      fireEvent.mouseLeave(marker.parentElement!)
    }
    expect(contentReads).toBe(0)

    const nextMessages = [...messages.slice(0, -1), {
      ...messages.at(-1)!, content: 'Current streamed answer', status: 'streaming' as const,
    }]
    page.rerender(view(nextMessages))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.getAllByTestId('message-turn-navigation-preview').at(-1))
      .toHaveTextContent('Current streamed answer')
    expect(contentReads).toBeLessThanOrEqual(messages.length * 2)

    page.rerender(view(nextMessages, [{ id: 'cold-user', messageIndex: 100, turnIndex: 24,
      cursor: 'offset:100', promptPreview: 'Unloaded history', responsePreview: 'Saved response' }, ...turnNavigation]))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(25)
    expect(screen.getAllByTestId('message-turn-navigation-preview').at(-1))
      .toHaveTextContent('Unloaded history')
    expect(screen.getAllByTestId('message-turn-navigation-preview')[23])
      .toHaveTextContent('Current streamed answer')
    nextMessages.at(-1)!.content = 'Updated in place'
    page.rerender(view(nextMessages))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.getAllByTestId('message-turn-navigation-preview').at(-1))
      .toHaveTextContent('Updated in place')
  } finally { page.unmount() }
})
