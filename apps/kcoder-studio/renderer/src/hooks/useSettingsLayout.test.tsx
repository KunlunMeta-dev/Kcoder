import { renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useSettingsLayout } from './useSettingsLayout'

test('pins the settings tree across breakpoints and adopts the current layout on exit', () => {
  const view = renderHook(({ mobile, open }) => useSettingsLayout(mobile, open), {
    initialProps: { mobile: false, open: false },
  })
  view.rerender({ mobile: false, open: true })
  view.rerender({ mobile: true, open: true })
  expect(view.result.current).toBe(false)
  view.rerender({ mobile: true, open: false })
  expect(view.result.current).toBe(true)
  view.rerender({ mobile: false, open: true })
  expect(view.result.current).toBe(true)
})
