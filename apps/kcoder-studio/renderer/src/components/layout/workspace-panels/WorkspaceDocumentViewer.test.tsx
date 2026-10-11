import { File as NodeFile } from 'node:buffer'
import officeRenderers from '@file-viewer/preset-office'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceDocumentViewer } from './WorkspaceDocumentViewer'

// Model-independent: real installed viewer/core/preset and native File reads.
// Node's File supplies arrayBuffer in jsdom; no viewer/renderer is mocked.
beforeEach(() => vi.stubGlobal('File', NodeFile))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const options = { preset: [officeRenderers], docx: { worker: false } }
function fixture(name = 'owned.unknown', bytes = 1024 * 1024) {
  const file = new File([new Uint8Array(bytes)], name)
  const read = vi.spyOn(file, 'arrayBuffer')
  return { file, read }
}
function preview(file: File, extra = {}) {
  return (
    <WorkspaceDocumentViewer
      file={file}
      filename={file.name}
      size={file.size}
      options={options}
      {...extra}
    />
  )
}
async function ready() {
  await waitFor(() => {
    expect(screen.queryByTestId('workspace-document-viewer-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-document-viewer-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-document-viewer-surface')).not.toHaveAttribute('inert')
  })
}
function deferredRead(file: File) {
  const original = file.arrayBuffer.bind(file)
  let resolve!: (bytes: ArrayBuffer) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ArrayBuffer>((done, fail) => {
    resolve = done
    reject = fail
  })
  const read = vi.spyOn(file, 'arrayBuffer').mockReturnValue(promise)
  return { read, finish: async () => resolve(await original()), reject }
}

test('reads a real 1 MiB File once under StrictMode, preserves rerenders and updates source props', async () => {
  const first = fixture()
  const view = render(<StrictMode>{preview(first.file)}</StrictMode>)
  await ready()
  expect(first.read).toHaveBeenCalledTimes(1)
  view.rerender(<StrictMode>{preview(first.file)}</StrictMode>)
  await ready()
  expect(first.read).toHaveBeenCalledTimes(1)
  view.rerender(
    <StrictMode>
      {preview(first.file, {
        filename: 'updated.unknown',
        type: 'owned-unknown-type',
        size: first.file.size,
        options: { ...options, theme: 'dark' },
      })}
    </StrictMode>
  )
  await ready()
  expect(first.read).toHaveBeenCalledTimes(2)
  // Same name/size, but a new File is a new source and must not reuse old bytes.
  const second = fixture()
  view.rerender(<StrictMode>{preview(second.file)}</StrictMode>)
  await ready()
  expect(second.read).toHaveBeenCalledTimes(1)
})

test('late old read success cannot complete the current still-pending source', async () => {
  const first = new File(['old'], 'old.unknown')
  const old = deferredRead(first)
  const second = new File(['new'], 'new.unknown')
  const current = deferredRead(second)
  const view = render(preview(first))
  await waitFor(() => expect(old.read).toHaveBeenCalledTimes(1))
  view.rerender(preview(second))
  await waitFor(() => expect(current.read).toHaveBeenCalledTimes(1))
  await act(old.finish)
  expect(screen.getByTestId('workspace-document-viewer-loading')).toBeVisible()
  expect(screen.getByTestId('workspace-document-viewer-surface')).toHaveAttribute('inert')
  expect(screen.queryByTestId('workspace-document-viewer-error')).not.toBeInTheDocument()
  await act(current.finish)
  await ready()
})

test('real invalid DOCX rejects, retry reads again and replacing it recovers', async () => {
  const broken = fixture('invalid.docx', 64)
  const view = render(preview(broken.file, { type: 'docx' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
  expect(screen.getByRole('alert')).toHaveTextContent(/无法预览|Could not preview/)
  expect(screen.getByTestId('workspace-document-viewer-surface')).toHaveAttribute('inert')
  expect(broken.read).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('workspace-document-viewer-retry'))
  await waitFor(() => expect(broken.read).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
  const valid = fixture('recovery.unknown')
  view.rerender(preview(valid.file))
  expect(screen.queryByTestId('workspace-document-viewer-error')).not.toBeInTheDocument()
  await ready()
  expect(valid.read).toHaveBeenCalledTimes(1)
})

test('obsolete read rejection does not replace current success and pending unmount releases its surface', async () => {
  const first = new File(['old'], 'old.unknown')
  const old = deferredRead(first)
  const view = render(preview(first))
  await waitFor(() => expect(old.read).toHaveBeenCalledTimes(1))
  const current = fixture()
  view.rerender(preview(current.file))
  await ready()
  await act(async () => old.reject(new Error('obsolete owned read rejection')))
  await ready()
  const last = new File(['pending'], 'pending.unknown')
  const pending = deferredRead(last)
  view.rerender(preview(last))
  await waitFor(() => expect(pending.read).toHaveBeenCalledTimes(1))
  const surface = screen.getByTestId('workspace-document-viewer-surface')
  view.unmount()
  await act(pending.finish)
  expect(surface).not.toBeInTheDocument()
  expect(surface.childElementCount).toBe(0)
  expect(view.container.childElementCount).toBe(0)
})

function disposalFixture(kind: 'throw' | 'reject') {
  const sessions: Array<{ destroyed: number; availabilityRead: number }> = []
  const registries = new Set<unknown>()
  class Session {
    #download = true
    constructor(private record: (typeof sessions)[number]) {}
    getAvailability() {
      this.record.availabilityRead++
      return { download: this.#download }
    }
    destroy() {
      this.record.destroyed++
      const error = new Error('owned private fixture detail must not enter diagnostics')
      if (kind === 'throw') throw error
      return Promise.reject(error)
    }
  }
  const plugin = {
    id: 'owned-disposal',
    definitions: [
      {
        id: 'owned-disposal-renderer',
        label: 'Owned disposal fixture',
        category: 'document' as const,
        extensions: ['odispose'],
        load({ surface }: { surface: { container: HTMLElement } }) {
          surface.container.textContent = 'Owned preview content'
          const record = { destroyed: 0, availabilityRead: 0 }
          sessions.push(record)
          return Object.freeze(new Session(record))
        },
      },
    ],
    install({ registry }: { registry: unknown }) {
      registries.add(registry)
    },
  }
  return { sessions, registries, plugin }
}

test.each(['throw', 'reject'] as const)(
  'a real frozen session with %s cleanup failure allows replacement and closes cleanly',
  async kind => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fault = disposalFixture(kind)
    const file = new File(['first'], 'first.odispose')
    const extra = { options: { ...options, renderers: fault.plugin, autoRenderers: false } }
    const originalLoader = fault.plugin.definitions[0].load
    const view = render(preview(file, extra))
    await ready()
    expect(fault.sessions[0].availabilityRead).toBeGreaterThan(0)
    view.rerender(preview(new File(['second'], 'second.odispose'), extra))
    await ready()
    expect(fault.sessions).toHaveLength(2)
    expect(fault.sessions[0].destroyed).toBe(1)
    expect(fault.plugin.definitions[0].load).toBe(originalLoader)
    view.unmount()
    await waitFor(() => expect(fault.sessions[1].destroyed).toBe(1))
    expect(warning).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warning.mock.calls)).not.toContain('owned private fixture detail')
  }
)

test('two real viewers keep separate renderer registries and loading instances', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fault = disposalFixture('throw')
  const extra = { options: { ...options, renderers: fault.plugin, autoRenderers: false } }
  const first = new File(['one'], 'one.odispose')
  const second = new File(['two'], 'two.odispose')
  const pair = (left: boolean) => (
    <>
      {left && <div key="left">{preview(first, extra)}</div>}
      <div key="right">{preview(second, extra)}</div>
    </>
  )
  const view = render(pair(true))
  await waitFor(() =>
    expect(screen.getAllByTestId('workspace-document-viewer-surface')).toHaveLength(2)
  )
  await waitFor(() =>
    expect(screen.queryAllByTestId('workspace-document-viewer-loading')).toHaveLength(0)
  )
  expect(screen.queryAllByTestId('workspace-document-viewer-error')).toHaveLength(0)
  expect(fault.registries.size).toBe(2)
  expect(fault.sessions).toHaveLength(2)
  view.rerender(pair(false))
  await ready()
  await waitFor(() =>
    expect(fault.sessions.filter(session => session.destroyed === 1)).toHaveLength(1)
  )
  expect(fault.sessions.filter(session => session.destroyed === 0)).toHaveLength(1)
  view.unmount()
  await waitFor(() => expect(fault.sessions.every(session => session.destroyed === 1)).toBe(true))
})

test('closing during real load-complete hook still disposes once and disconnects framework observers', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const active = new Set<MutationObserver>()
  const observe = MutationObserver.prototype.observe
  const disconnect = MutationObserver.prototype.disconnect
  vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(function (
    this: MutationObserver,
    ...args
  ) {
    // Count real viewer roots, not Testing Library's own waitFor observer.
    if (
      args[0] instanceof Element &&
      args[0].closest('[data-testid="workspace-document-viewer-surface"]')
    )
      active.add(this)
    return observe.apply(this, args)
  })
  vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementation(function (
    this: MutationObserver
  ) {
    active.delete(this)
    return disconnect.call(this)
  })
  let finish!: () => void
  const held = new Promise<void>(resolve => {
    finish = resolve
  })
  let entered = false
  const fault = disposalFixture('reject')
  const view = render(
    preview(new File(['owned'], 'pending.odispose'), {
      options: {
        ...options,
        renderers: fault.plugin,
        autoRenderers: false,
        hooks: {
          async onLoadComplete() {
            entered = true
            await held
          },
        },
      },
    })
  )
  try {
    await waitFor(() => expect(entered).toBe(true))
    expect(active.size).toBe(3)
    view.unmount()
    await waitFor(() => expect(fault.sessions[0].destroyed).toBe(1))
    await waitFor(() => expect(active.size).toBe(0))
  } finally {
    finish()
    await act(async () => {
      await held
    })
    for (const observer of active) observer.disconnect()
  }
  expect(view.container.childElementCount).toBe(0)
})
