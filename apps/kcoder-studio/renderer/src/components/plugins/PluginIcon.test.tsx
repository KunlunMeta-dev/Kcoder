import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { PluginIcon } from './PluginIcon'

vi.mock('@/features/appearance', () => ({
  useOptionalAppearance: () => ({ resolvedMode: 'dark' }),
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('displays the primary icon without waiting for the optional light probe', async () => {
  const light = deferred<string | null>()
  const loader = vi.fn((_id: string, dark: boolean) =>
    dark ? Promise.resolve('https://icons.test/dark.svg') : light.promise
  )
  const view = render(<PluginIcon id="owned" loader={loader} />)
  await waitFor(() =>
    expect(view.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://icons.test/dark.svg'
    )
  )
  await act(async () => light.resolve('https://icons.test/light.svg'))
  expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://icons.test/dark.svg')
})

test('keeps a valid dark icon when the optional light read fails', async () => {
  const loader = vi.fn((_id: string, dark: boolean) =>
    dark
      ? Promise.resolve('https://icons.test/dark.svg')
      : Promise.reject(new Error('light unavailable'))
  )
  const view = render(<PluginIcon id="owned" loader={loader} />)
  await waitFor(() =>
    expect(view.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://icons.test/dark.svg'
    )
  )
})

test('uses the light icon if the dark read is missing or the image fails to decode', async () => {
  const loader = vi.fn((_id: string, dark: boolean) =>
    Promise.resolve(dark ? 'https://icons.test/dark.svg' : 'https://icons.test/light.svg')
  )
  const view = render(<PluginIcon id="owned" loader={loader} />)
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
  await act(async () => fireEvent.error(view.container.querySelector('img')!))
  await waitFor(() =>
    expect(view.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://icons.test/light.svg'
    )
  )
  view.rerender(
    <PluginIcon
      id="missing-dark"
      loader={(_id, dark) => Promise.resolve(dark ? null : 'https://icons.test/fallback.svg')}
    />
  )
  await waitFor(() =>
    expect(view.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://icons.test/fallback.svg'
    )
  )
})

test('retries the same failed URL after proxy invalidation', async () => {
  const view = render(<PluginIcon id="owned" source="https://icons.test/same.svg" preferSource />)
  fireEvent.error(view.container.querySelector('img')!)
  expect(view.container.querySelector('img')).toBeNull()
  act(() => window.dispatchEvent(new Event('kcoder:plugin-icons-invalidated')))
  await waitFor(() =>
    expect(view.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://icons.test/same.svg'
    )
  )
})

test('a late result from the previous loader cannot replace the current target icon', async () => {
  const pending = deferred<string | null>()
  const old = vi.fn(() => pending.promise)
  const current = vi.fn(() => Promise.resolve('https://icons.test/current.svg'))
  const view = render(<PluginIcon id="owned" loader={old} />)
  view.rerender(<PluginIcon id="owned" loader={current} />)
  await waitFor(() =>
    expect(view.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://icons.test/current.svg'
    )
  )
  await act(async () => pending.resolve('https://icons.test/old.svg'))
  expect(view.container.querySelector('img')).toHaveAttribute(
    'src',
    'https://icons.test/current.svg'
  )
})
