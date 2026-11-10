import { webcrypto, createHash } from 'node:crypto'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineWidgetHost, WidgetDocumentHost, WidgetStreamPreview, type WidgetFrameLease, type WidgetAppMessageContext } from './InlineWidgetHost'
import type { InlineWidgetReference } from './types'
import { loadWidgetResources } from './resources'

vi.mock('./resources', () => ({ loadWidgetResources: vi.fn(async () => ({ librarySources: {}, topology: undefined, licenses: [] })) }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue, i18n: { language: 'en' } }) }))

const source = '<svg xmlns="http://www.w3.org/2000/svg"><title>Test</title><text>你好</text></svg>'
const reference: InlineWidgetReference = {
  widgetId: 'widget-a', threadId: 'thread-a', turnId: 'turn-a', attemptId: 'attempt-a', toolCallId: 'call-a',
  revision: 1, title: 'Test visualization', summary: 'Fallback summary', format: 'svg', executionMode: 'managed', libraries: [],
  sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source), createdAtMs: 0,
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IntersectionObserver', undefined)
})
afterEach(() => vi.unstubAllGlobals())

async function initializeFrame() {
  const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  fireEvent.load(frame)
  expect(post).toHaveBeenCalled()
  const init = post.mock.calls.at(-1)![0] as { token: string; widgetId: string; revision: number }
  return { frame, post, init }
}

function receive(frame: HTMLIFrameElement, init: { token: string; widgetId: string; revision: number }, type: string, payload: unknown = {}) {
  act(() => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, data: { protocol: 'kcoder-widget', version: 1, token: init.token, widgetId: init.widgetId, revision: init.revision, type, payload },
  })))
}

describe('trusted managed widget host', () => {
  it('expands long visualizations to their content height and follows later shrinking', async () => {
    render(<InlineWidgetHost widget={reference} panelId="full-height:left" loadContent={async () => source} />)
    const { frame, init } = await initializeFrame()
    receive(frame, init, 'resize', { height: 2400.4 })
    expect(frame).toHaveStyle({ height: '2401px' })
    expect(screen.getByTestId('widget-frame-slot')).toHaveStyle({ height: '2401px' })
    receive(frame, { ...init, token: 'another-mount' }, 'resize', { height: 9000 })
    receive(frame, init, 'resize', { height: Infinity })
    expect(frame).toHaveStyle({ height: '2401px' })
    receive(frame, init, 'resize', { height: 280 })
    expect(frame).toHaveStyle({ height: '280px' })
  })
  it('verifies bytes/hash before mounting an opaque frame and exposes no parent RPC', async () => {
    const load = vi.fn(async () => source)
    const onFeedback = vi.fn()
    render(<InlineWidgetHost widget={reference} panelId="target-a:left" loadContent={load} onFeedback={onFeedback} />)
    const { frame, init } = await initializeFrame()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('src')).toBe('/api/widgets/sandbox-v1.html')
    receive(frame, init, 'ready')
    expect(onFeedback).toHaveBeenCalledWith({ status: 'ready', widgetId: 'widget-a', revision: 1 })
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('does not refetch or remount when a parent streams an unrelated delta', async () => {
    const load = vi.fn(async () => source)
    const { rerender } = render(<InlineWidgetHost widget={reference} panelId="target-a:left" loadContent={load} />)
    const { frame } = await initializeFrame()
    rerender(<InlineWidgetHost widget={{ ...reference }} panelId="target-a:left" loadContent={async (...args) => load(...args)} />)
    await waitFor(() => expect(screen.getByTestId('inline-widget-frame')).toBe(frame))
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('keeps its measured body height when lazy unloading and still lets the user hide it', async () => {
    let intersect!: IntersectionObserverCallback
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {}
      disconnect() {}
    })
    render(<InlineWidgetHost widget={reference} panelId="stable-slot:left" loadContent={async () => source} />)
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    expect(screen.getByTestId('widget-frame-slot')).toHaveStyle({ height: '320px' })
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const { frame, init } = await initializeFrame()
    receive(frame, init, 'resize', { height: 440 })
    receive(frame, init, 'ready')
    act(() => intersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    expect(screen.getByTestId('widget-frame-slot')).toHaveStyle({ height: '440px' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('widget-frame-slot')).toBeNull()
  })
  it('retains license metadata without exposing a footer in the conversation', async () => {
    vi.mocked(loadWidgetResources).mockResolvedValueOnce({ librarySources: {}, topology: undefined, licenses: [{ title: 'Retained library notice', url: '/assets/library.LICENSE' }] })
    render(<InlineWidgetHost widget={reference} panelId="license-ui:left" loadContent={async () => source} />)
    const { frame, init, post } = await initializeFrame()
    receive(frame, init, 'ready')
    expect(post.mock.calls[0][0]).toHaveProperty('licenses', [{ title: 'Retained library notice', url: '/assets/library.LICENSE' }])
    expect(screen.queryByText('Open source licenses')).toBeNull()
    expect(screen.queryByText('Retained library notice')).toBeNull()
  })
  it('follows a system color-scheme change without rebuilding the widget document', async () => {
    const callbacks = new Map<string, () => void>()
    let dark = false
    const originalTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = 'system'
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query.includes('color-scheme') && dark },
      addEventListener: (_event: string, callback: () => void) => callbacks.set(query, callback),
      removeEventListener: () => callbacks.delete(query),
    }))
    try {
      render(<InlineWidgetHost widget={reference} panelId="theme:system" loadContent={async () => source} />)
      const { frame, init, post } = await initializeFrame()
      receive(frame, init, 'ready')
      expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'theme', theme: { colorScheme: 'light' } })
      act(() => { dark = true; callbacks.get('(prefers-color-scheme: dark)')?.() })
      await waitFor(() => expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'theme', theme: { colorScheme: 'dark' } }))
      expect(screen.getByTestId('inline-widget-frame')).toBe(frame)
      expect(post.mock.calls.filter(([message]) => message.type === 'init')).toHaveLength(1)
    } finally {
      if (originalTheme === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = originalTheme
    }
  })
  it('rejects a mismatched source instead of executing it', async () => {
    const onFeedback = vi.fn()
    render(<InlineWidgetHost widget={{ ...reference, sha256: '0'.repeat(64) }} panelId="target-a:left" loadContent={async () => source} onFeedback={onFeedback} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('widget content hash mismatch')
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })
  it('preserves content verification on LAN HTTP without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    render(<InlineWidgetHost widget={reference} panelId="http-lan:left" loadContent={async () => source} />)
    expect(await screen.findByTestId('inline-widget-frame')).toBeInTheDocument()
  })
  it('requires source window, token and revision before accepting draft prompts', async () => {
    const prompt = vi.fn()
    render(<InlineWidgetHost widget={reference} panelId="target-a:left" loadContent={async () => source} onSendPrompt={prompt} />)
    const { frame, init } = await initializeFrame()
    act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data: { protocol: 'kcoder-widget', version: 1, ...init, type: 'sendPrompt', payload: { text: 'spoofed' } } })))
    receive(frame, { ...init, token: 'forged' }, 'sendPrompt', { text: 'forged' })
    receive(frame, { ...init, revision: 0 }, 'sendPrompt', { text: 'old' })
    expect(prompt).not.toHaveBeenCalled()
    receive(frame, init, 'sendPrompt', { text: 'Explain this chart' })
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith('Explain this chart')
  })
  it('does not let a late ready event erase a confirmed rendering failure', async () => {
    const feedback = vi.fn()
    render(<InlineWidgetHost widget={reference} panelId="target-a:left" loadContent={async () => source} onFeedback={feedback} />)
    const { frame, init } = await initializeFrame()
    receive(frame, init, 'error', { message: 'actual script failure' })
    receive(frame, init, 'ready')
    expect(screen.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', 'error')
    expect(feedback).toHaveBeenCalledOnce()
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })
  it('keeps managed unconfirmed feedback distinct from success and failure', async () => {
    const feedback = vi.fn()
    render(<InlineWidgetHost widget={reference} panelId="managed:unconfirmed" loadContent={async () => source} onFeedback={feedback} />)
    const { frame, init } = await initializeFrame()
    receive(frame, init, 'unconfirmed')
    expect(screen.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', 'unconfirmed')
    expect(screen.getByRole('status')).toHaveTextContent('Drawing is not confirmed')
    expect(screen.queryByRole('alert')).toBeNull()
    receive(frame, init, 'ready')
    expect(feedback).toHaveBeenCalledExactlyOnceWith({ status: 'unconfirmed', widgetId: 'widget-a', revision: 1 })
    expect(screen.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', 'unconfirmed')
  })
  it('accepts readiness from a new lazy frame after an unconfirmed frame leaves the viewport', async () => {
    let intersect!: IntersectionObserverCallback
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {}
      disconnect() {}
    })
    const feedback = vi.fn()
    render(<InlineWidgetHost widget={reference} panelId="managed:reenter" loadContent={async () => source} onFeedback={feedback} />)
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const previous = await initializeFrame()
    receive(previous.frame, previous.init, 'unconfirmed')
    act(() => intersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const current = await initializeFrame()
    expect(current.frame).not.toBe(previous.frame)
    receive(previous.frame, previous.init, 'ready')
    expect(feedback.mock.calls.map(([value]) => value.status)).toEqual(['unconfirmed'])
    receive(current.frame, current.init, 'ready')
    expect(feedback.mock.calls.map(([value]) => value.status)).toEqual(['unconfirmed', 'ready'])
    expect(screen.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', 'ready')
  })
  it('stops a managed verification frame after unconfirmed without accepting its late ready', async () => {
    const feedback = vi.fn()
    render(<WidgetDocumentHost widget={reference} panelId="managed:probe-unconfirmed" documentMode="managed" verificationOnly loadContent={async () => source} onFeedback={feedback} />)
    const { frame, init } = await initializeFrame()
    receive(frame, init, 'unconfirmed')
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    receive(frame, init, 'ready')
    expect(feedback).toHaveBeenCalledExactlyOnceWith({ status: 'unconfirmed', widgetId: 'widget-a', revision: 1 })
  })
  it('releases a flooded channel and stops accepting its messages', async () => {
    const prompt = vi.fn()
    render(<InlineWidgetHost widget={reference} panelId="target-a:left" loadContent={async () => source} onSendPrompt={prompt} />)
    const { frame, init } = await initializeFrame()
    for (let i = 0; i < 41; i += 1) receive(frame, init, 'resize', { height: 200 + i })
    expect(await screen.findByRole('alert')).toHaveTextContent('message rate exceeded')
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    receive(frame, init, 'sendPrompt', { text: 'stale' })
    expect(prompt).not.toHaveBeenCalled()
  })
  it('does not load hidden, offscreen or unverified JavaScript widgets', async () => {
    const load = vi.fn(async () => source)
    const { rerender } = render(<InlineWidgetHost widget={reference} panelId="target-a:left" loadContent={load} visible={false} />)
    expect(load).not.toHaveBeenCalled()
    rerender(<InlineWidgetHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="target-a:left" loadContent={load} />)
    expect(screen.getByText(/requires an enabled isolated execution host/)).toBeInTheDocument()
    expect(load).not.toHaveBeenCalled()
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
  })
  it('keeps receiving content passive instead of mounting partial scripts', () => {
    render(<WidgetStreamPreview title="Building chart" summary="Actual source is still arriving" receivedBytes={1234} />)
    expect(screen.getByTestId('widget-stream-preview')).toHaveTextContent('1,234 B')
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
})

describe('isolated document admission', () => {
  it('blocks old-frame readiness synchronously when a native pending frame is revoked', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    let revoke!: (reason: string) => void
    const feedback = vi.fn()
    const lease = { release: vi.fn(), heartbeat: vi.fn(), onRevoked: vi.fn(callback => { revoke = callback; return vi.fn() }) }
    try {
      render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="native:revoke-before-render" documentMode="isolated_html" authorizeFrame={async () => lease} loadContent={async () => source} onFeedback={feedback} />)
      const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
      const post = vi.spyOn(frame.contentWindow!, 'postMessage')
      fireEvent.load(frame)
      await waitFor(() => expect(post).toHaveBeenCalled())
      const init = post.mock.calls.at(-1)![0] as { token: string; widgetId: string; revision: number }
      receive(frame, init, 'heartbeat', { domNodes: 30, canvasPixels: 0, ready: false })
      act(() => {
        revoke('component did not become ready')
        // Deliver before React removes the revoked iframe, not only after its cleanup.
        window.dispatchEvent(new MessageEvent('message', {
          source: frame.contentWindow,
          data: { protocol: 'kcoder-widget', version: 1, ...init, type: 'ready', payload: {} },
        }))
      })
      expect(feedback).toHaveBeenCalledExactlyOnceWith({ status: 'unconfirmed', widgetId: 'widget-a', revision: 1 })
      expect(screen.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', 'unconfirmed')
      expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
      expect(lease.release).toHaveBeenCalledOnce()
    } finally {
      clock.mockRestore()
    }
  })
  it.each([
    { label: 'current pending heartbeat at the freshness boundary', heartbeat: 'pending', age: 600, reason: 'component did not become ready', expected: 'unconfirmed' },
    { label: 'missing heartbeat', heartbeat: 'none', age: 0, reason: 'component did not become ready', expected: 'error' },
    { label: 'expired pending heartbeat', heartbeat: 'pending', age: 601, reason: 'component did not become ready', expected: 'error' },
    { label: 'heartbeat from a different revision', heartbeat: 'wrong-revision', age: 0, reason: 'component did not become ready', expected: 'error' },
    { label: 'heartbeat with another mount token', heartbeat: 'wrong-token', age: 0, reason: 'component did not become ready', expected: 'error' },
    { label: 'invalid heartbeat metrics', heartbeat: 'invalid', age: 0, reason: 'component did not become ready', expected: 'error' },
    { label: 'ready heartbeat without pending evidence', heartbeat: 'ready', age: 0, reason: 'component did not become ready', expected: 'error' },
    { label: 'quota revocation despite a pending heartbeat', heartbeat: 'pending', age: 0, reason: 'component exceeded its canvas budget', expected: 'error' },
  ])('releases the native lease and classifies $label', async ({ heartbeat, age, reason, expected }) => {
    let revoke!: (reason: string) => void
    let now = 1000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const feedback = vi.fn()
    const lease = { release: vi.fn(), heartbeat: vi.fn(), onRevoked: vi.fn(callback => { revoke = callback; return vi.fn() }) }
    try {
      render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId={`native:${heartbeat}:${age}:${reason}`} documentMode="isolated_html" authorizeFrame={async () => lease} loadContent={async () => source} onFeedback={feedback} />)
      const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
      const post = vi.spyOn(frame.contentWindow!, 'postMessage')
      fireEvent.load(frame)
      await waitFor(() => expect(post).toHaveBeenCalled())
      const init = post.mock.calls.at(-1)![0] as { token: string; widgetId: string; revision: number }
      if (heartbeat !== 'none') {
        const binding = heartbeat === 'wrong-revision' ? { ...init, revision: 0 } : heartbeat === 'wrong-token' ? { ...init, token: 'previous-mount-token' } : init
        receive(frame, binding, 'heartbeat', {
          domNodes: heartbeat === 'invalid' ? -1 : 30, canvasPixels: 0, ready: heartbeat === 'ready',
        })
      }
      now += age
      act(() => revoke(reason))
      expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
      expect(lease.release).toHaveBeenCalledOnce()
      expect(feedback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: expected }))
      expect(screen.getByTestId('inline-widget')).toHaveAttribute('data-widget-status', expected)
      if (expected === 'unconfirmed') expect(screen.queryByRole('alert')).toBeNull()
      else expect(screen.getByRole('alert')).toHaveTextContent(reason)
      receive(frame, init, 'ready')
      expect(feedback).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })
  it('waits for native ownership proof before sending executable source', async () => {
    let resolveLease!: (lease: WidgetFrameLease) => void
    let revoke!: (reason: string) => void
    const lease = { release: vi.fn(), heartbeat: vi.fn(), onRevoked: vi.fn(callback => { revoke = callback; return vi.fn() }) }
    const authorize = vi.fn(() => new Promise<WidgetFrameLease>(resolve => { resolveLease = resolve }))
    render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="native:left" documentMode="isolated_html" sandboxDocumentUrl="/api/widgets/isolated-v1.html" authorizeFrame={authorize} loadContent={async () => source} />)
    const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    fireEvent.load(frame)
    expect(authorize).toHaveBeenCalledWith(frame, expect.objectContaining({ executionMode: 'isolated_html' }), frame.name)
    expect(authorize).toHaveBeenCalledOnce()
    expect(post).not.toHaveBeenCalled()
    await act(async () => resolveLease(lease))
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'isolated_html', source }), '*')
    const init = post.mock.calls.at(-1)![0] as { token: string; widgetId: string; revision: number }
    receive(frame, init, 'heartbeat', { domNodes: 30, canvasPixels: 700 * 320, ready: true })
    expect(lease.heartbeat).toHaveBeenCalledWith({ domNodes: 30, canvasPixels: 700 * 320, ready: true })
    act(() => revoke('component stopped responding'))
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    expect(lease.release).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent('component stopped responding')
  })
  it('releases a native lease that arrives after its frame has unmounted', async () => {
    let resolveLease!: (lease: WidgetFrameLease) => void
    const authorize = vi.fn(() => new Promise<WidgetFrameLease>(resolve => { resolveLease = resolve }))
    const { unmount } = render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="native:left" documentMode="isolated_html" authorizeFrame={authorize} loadContent={async () => source} />)
    const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    unmount()
    const lease = { release: vi.fn(async () => { throw new Error('native owner already shut down') }), heartbeat: vi.fn(), onRevoked: vi.fn() }
    await act(async () => resolveLease(lease))
    expect(lease.release).toHaveBeenCalledOnce()
    expect(post).not.toHaveBeenCalled()
  })
  it('enables JSON-RPC only for an explicit App callback and keeps larger host replies bounded', async () => {
    let context!: WidgetAppMessageContext
    const app = vi.fn(value => { context = value })
    const lease = { release: vi.fn(), heartbeat: vi.fn(), onRevoked: vi.fn(() => vi.fn()) }
    const { unmount } = render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="native:app" documentMode="isolated_html" authorizeFrame={async () => lease} onAppMessage={app} loadContent={async () => source} />)
    const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    await waitFor(() => expect(post).toHaveBeenCalled())
    const message = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: message })))
    expect(app).toHaveBeenCalledOnce()
    expect(context.message).toEqual(message)
    act(() => context.resize(1800))
    expect(frame).toHaveStyle({ height: '1800px' })
    expect(() => context.resize(NaN)).toThrow(/invalid/)
    context.reply({ jsonrpc: '2.0', id: 1, result: { content: 'x'.repeat(128 * 1024) } })
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ id: 1, result: expect.any(Object) })
    expect(() => context.reply({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(1024 * 1024) })).toThrow(/1 MiB/)
    for (let index = 0; index < 39; index += 1) context.reply({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { index } })
    expect(() => context.reply({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {} })).toThrow(/40 messages/)
    unmount()
    expect(() => context.reply({ jsonrpc: '2.0', id: 1, result: {} })).toThrow(/unavailable/)
  })
  it('responds to rejected App handlers and oversized requests instead of leaving promises pending', async () => {
    const app = vi.fn(async () => { throw new Error('private internal cause') })
    const lease = { release: vi.fn(), heartbeat: vi.fn(), onRevoked: vi.fn(() => vi.fn()) }
    render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="native:app-errors" documentMode="isolated_html" authorizeFrame={async () => lease} onAppMessage={app} loadContent={async () => source} />)
    const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    await waitFor(() => expect(post).toHaveBeenCalled())
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { jsonrpc: '2.0', id: 7, method: 'unsupported' } })))
    expect(post.mock.calls.at(-1)?.[0]).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Widget App request could not be completed' } })
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: 'x'.repeat(32 * 1024) } })))
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ id: 8, error: { code: -32600 } })
    expect(app).toHaveBeenCalledOnce()
    expect(lease.release).toHaveBeenCalledOnce()
  })
  it('makes first-frame probes inert, blocks App/draft/state actions, and releases the real lease after feedback', async () => {
    const app = vi.fn(), prompt = vi.fn(), state = vi.fn(), feedback = vi.fn()
    const lease = { release: vi.fn(), heartbeat: vi.fn(), onRevoked: vi.fn(() => vi.fn()) }
    render(<WidgetDocumentHost widget={{ ...reference, executionMode: 'isolated_html' }} panelId="native:probe" documentMode="isolated_html" verificationOnly authorizeFrame={async () => lease} onAppMessage={app} onSendPrompt={prompt} onState={state} onFeedback={feedback} loadContent={async () => source} />)
    const frame = await screen.findByTestId('inline-widget-frame') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(frame).toHaveAttribute('tabindex', '-1')
    expect(frame).toHaveClass('pointer-events-none')
    expect(screen.getByTestId('inline-widget')).toHaveAttribute('inert')
    const init = post.mock.calls.at(-1)![0] as { token: string; widgetId: string; revision: number }
    receive(frame, init, 'sendPrompt', { text: 'must not send' })
    receive(frame, init, 'state', { state: { value: 999 } })
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { jsonrpc: '2.0', id: 1, method: 'tools/call' } })))
    expect(app).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled(); expect(state).not.toHaveBeenCalled()
    receive(frame, init, 'ready')
    expect(feedback).toHaveBeenCalledWith({ status: 'ready', widgetId: 'widget-a', revision: 1 })
    expect(screen.queryByTestId('inline-widget-frame')).toBeNull()
    expect(lease.release).toHaveBeenCalledOnce()
  })
})
