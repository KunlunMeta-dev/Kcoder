import '@/i18n'
import { act, render, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
import type { ProcessingBlock } from '@/types/workbench'
import { useGeneratingToolBlocks } from './useGeneratingToolBlocks'
import { ToolLineProgress } from './blocks/ToolLineProgress'

function progressFixture() {
  const consumer = new ToolPathPreviewConsumer(), client = {}, sequences = new Map<string, number>()
  const releases = [toolPathPreviews.acquire('target', 'task'), toolPathPreviews.acquire('other', 'task')]
  return {
    send(method: string, target = 'target', extra = {}) {
      const sequence = (sequences.get(target) ?? 0) + 1
      sequences.set(target, sequence)
      consumer.handle(method, { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence,
        ...extra }, target, 'task', client)
    },
    input(id: string, chars: number, target = 'target') {
      this.send('item/event', target, { event: { type: 'tool_input_progress', id, name: 'write', chars } })
    },
    dispose() { releases.forEach(release => release()); consumer.dispose() },
  }
}

test('argument counters update their own rows without rebuilding the parent projection', () => {
  const events = progressFixture(), blocks: ProcessingBlock[] = [], observed = vi.fn()
  function GeneratingRows() {
    const projection = useGeneratingToolBlocks(blocks, true, 'message', 'attempt', '')
    observed(projection)
    return <>{projection.blocks.map(block => <ToolLineProgress key={block.id} id={block.id} running />)}</>
  }
  const view = render(<GeneratingRows />, {
    wrapper: ({ children }) => <ToolProgressScopeContext.Provider value={{ target: 'target', task: 'task' }}>{children}</ToolProgressScopeContext.Provider>,
  })
  const input = (chars: number) => events.send('item/event', 'target', {
    displayText: { en: 'Writer', 'zh-CN': '写入' },
    event: { type: 'tool_input_progress', id: 'writer', name: 'write', chars, lines: { generatedLines: chars } },
  })
  try {
    act(() => { events.send('turn/started'); input(1) })
    const before = observed.mock.calls.length
    act(() => events.send('turn/started', 'other'))
    const read = vi.spyOn(toolPathPreviews, 'readToolLines')
    try {
      for (let chars = 1; chars <= 40; chars++) act(() => events.input('peer-writer', chars, 'other'))
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
    for (let chars = 2; chars <= 41; chars++) {
      act(() => input(chars))
      expect(view.getByTestId('tool-line-progress')).toHaveTextContent(`+${chars}`)
    }
    expect(observed).toHaveBeenCalledTimes(before)
    act(() => events.send('item/event', 'target', { displayText: { en: 'New writer' },
      event: { type: 'tool_input_progress', id: 'writer', name: 'write', chars: 42, lines: { generatedLines: 42 } } }))
    expect(observed).toHaveBeenCalledTimes(before + 1)
    expect(observed.mock.calls.at(-1)?.[0].blocks.at(-1)?.displayText).toEqual({ en: 'New writer' })
    expect(view.getByTestId('tool-line-progress')).toHaveTextContent('+42')
    act(() => events.send('item/started', 'target', { item: { type: 'toolCall', id: 'writer' } }))
    expect(observed).toHaveBeenCalledTimes(before + 2)
    expect(view.queryByTestId('tool-line-progress')).toBeNull()
  } finally { view.unmount(); events.dispose() }
})

test('text updates without pending inputs do not scan saved tools, and reset forgets the previous transient identity', () => {
  const events = progressFixture()
  let historyReads = 0
  const blocks: ProcessingBlock[] = Array.from({ length: 64 }, (_, index) => ({
    get id() { historyReads++; return `saved-${index}` },
    type: 'tool', toolName: 'read', status: 'done', createdAt: index,
  }))
  const view = renderHook(({ content }) => useGeneratingToolBlocks(blocks, true, 'message', 'attempt', content), {
    initialProps: { content: '' },
    wrapper: ({ children }) => <ToolProgressScopeContext.Provider value={{ target: 'target', task: 'task' }}>{children}</ToolProgressScopeContext.Provider>,
  })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    historyReads = 0
    for (let index = 0; index < 40; index++) view.rerender({ content: `Text chunk ${index}` })
    expect(historyReads).toBe(0)
    expect(view.result.current).toEqual({ blocks, projectedNarrative: false })
    act(() => { events.send('turn/started'); events.input('pending', 1) })
    expect(view.result.current.blocks.at(-1)?.createdAt).toBe(1000)
    act(() => events.send('item/event', 'target', { event: { type: 'tool_input_reset' } }))
    expect(view.result.current).toEqual({ blocks, projectedNarrative: false })
    clock.mockReturnValue(2000)
    act(() => events.input('pending', 2))
    expect(view.result.current.blocks.at(-1)?.createdAt).toBe(2000)
  } finally { view.unmount(); events.dispose(); clock.mockRestore() }
})

test('foreign inputs and unrelated file progress do not rerender or merge the current generating projection', () => {
  const events = progressFixture(), blocks: ProcessingBlock[] = []
  let renders = 0
  const view = renderHook(() => {
    renders++
    return useGeneratingToolBlocks(blocks, true, 'message', 'attempt', 'Narrative')
  }, { wrapper: ({ children }) => <ToolProgressScopeContext.Provider value={{ target: 'target', task: 'task' }}>{children}</ToolProgressScopeContext.Provider> })
  try {
    act(() => { events.send('turn/started'); events.send('turn/started', 'other'); events.input('current', 1) })
    expect(view.result.current.blocks.map(block => block.id)).toEqual(['message:generating-narrative:current', 'current'])
    const displayed = view.result.current, before = renders, revision = toolPathPreviews.snapshot()
    const readInputs = vi.spyOn(toolPathPreviews, 'readInputs')
    try {
      for (let chars = 1; chars <= 40; chars++) act(() => events.input('foreign', chars, 'other'))
      expect(readInputs).not.toHaveBeenCalled()
    } finally { readInputs.mockRestore() }
    for (let chars = 1; chars <= 40; chars++) act(() => {
      events.input('foreign', chars, 'other')
      events.send('item/event', 'target', { event: { type: 'workspace_file_progress',
        counts: { additions: chars, deletions: 0, files: 1 } } })
    })
    expect(toolPathPreviews.snapshot()).toBeGreaterThanOrEqual(revision + 80)
    expect(renders).toBe(before)
    expect(view.result.current).toBe(displayed)
    const read = vi.spyOn(toolPathPreviews, 'readInputs')
    try {
      act(() => events.input('current', 2))
      expect(read).toHaveBeenCalledTimes(1)
    } finally { read.mockRestore() }
    expect(view.result.current).toBe(displayed)
    expect(view.result.current.blocks.at(-1)?.id).toBe('current')
    act(() => events.send('item/started', 'target', { item: { type: 'toolCall', id: 'current' } }))
    expect(view.result.current).toEqual({ blocks, projectedNarrative: false })
    act(() => events.input('next', 1))
    expect(view.result.current.blocks.at(-1)?.id).toBe('next')
    act(() => events.send('turn/completed'))
    expect(view.result.current).toEqual({ blocks, projectedNarrative: false })
  } finally { view.unmount(); events.dispose() }
})

test('switching target or disabling projection cannot reuse the previous input snapshot', () => {
  const events = progressFixture(), blocks: ProcessingBlock[] = []
  let target = 'target'
  const view = renderHook(({ enabled }) => useGeneratingToolBlocks(blocks, enabled, 'message', 'attempt', ''), {
    initialProps: { enabled: true },
    wrapper: ({ children }) => <ToolProgressScopeContext.Provider value={{ target, task: 'task' }}>{children}</ToolProgressScopeContext.Provider>,
  })
  try {
    act(() => { events.send('turn/started'); events.send('turn/started', 'other'); events.input('first', 1); events.input('second', 1, 'other') })
    expect(view.result.current.blocks.map(block => block.id)).toEqual(['first'])
    target = 'other'
    view.rerender({ enabled: true })
    expect(view.result.current.blocks.map(block => block.id)).toEqual(['second'])
    const current = view.result.current
    act(() => events.input('first', 2))
    expect(view.result.current).toBe(current)
    view.rerender({ enabled: false })
    expect(view.result.current.blocks).toBe(blocks)
    act(() => events.send('turn/completed', 'other'))
    view.rerender({ enabled: true })
    expect(view.result.current.blocks).toBe(blocks)
  } finally { view.unmount(); events.dispose() }
})

test('foreign progress interleaved with body deltas does not rescan current tool inputs', () => {
  const events = progressFixture(), blocks: ProcessingBlock[] = []
  const view = renderHook(({ content }) => useGeneratingToolBlocks(blocks, true, 'message', 'attempt', content), {
    initialProps: { content: '' },
    wrapper: ({ children }) => <ToolProgressScopeContext.Provider value={{ target: 'target', task: 'task' }}>{children}</ToolProgressScopeContext.Provider>,
  })
  try {
    act(() => { events.send('turn/started'); events.send('turn/started', 'other'); events.input('current', 1) })
    const pending = view.result.current.blocks.at(-1)
    const read = vi.spyOn(toolPathPreviews, 'readInputs')
    try {
      for (let index = 0; index < 40; index++) {
        act(() => events.input('foreign', index + 1, 'other'))
        view.rerender({ content: `Body delta ${index}` })
        expect(view.result.current.blocks.at(-1)).toBe(pending)
      }
      expect(read).not.toHaveBeenCalled()
      act(() => events.input('second-current', 1))
      expect(read).toHaveBeenCalledTimes(1)
      expect(view.result.current.blocks.at(-1)?.id).toBe('second-current')
      act(() => events.send('turn/completed'))
      expect(view.result.current).toEqual({ blocks, projectedNarrative: false })
    } finally { read.mockRestore() }
  } finally { view.unmount(); events.dispose() }
})

test('subscription setup reconciles an input arriving after render but before listener registration', () => {
  const events = progressFixture(), blocks: ProcessingBlock[] = []
  events.send('turn/started')
  const subscribe = toolPathPreviews.subscribe.bind(toolPathPreviews)
  let inserted = false
  const observation = vi.spyOn(toolPathPreviews, 'subscribe').mockImplementation((listener, target, task) => {
    if (target === 'target' && !inserted) { inserted = true; events.input('during-subscribe', 1) }
    return subscribe(listener, target, task)
  })
  const view = renderHook(() => useGeneratingToolBlocks(blocks, true, 'message', 'attempt', ''), {
    wrapper: ({ children }) => <ToolProgressScopeContext.Provider value={{ target: 'target', task: 'task' }}>{children}</ToolProgressScopeContext.Provider>,
  })
  try {
    expect(inserted).toBe(true)
    expect(view.result.current.blocks.at(-1)?.id).toBe('during-subscribe')
    act(() => events.send('turn/completed'))
    expect(view.result.current).toEqual({ blocks, projectedNarrative: false })
  } finally { view.unmount(); observation.mockRestore(); events.dispose() }
})
