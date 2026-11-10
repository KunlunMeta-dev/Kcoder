import { installTestDesktopHost, installTestTransport } from '@/test/runtime-transport'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useIsMobile } from './useIsMobile'

const originalInnerWidth = window.innerWidth

describe('useIsMobile', () => {
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete (window as typeof window & { __KCODER_GATEWAY_WEB_SHIM__?: unknown })
      .__KCODER_GATEWAY_WEB_SHIM__
    vi.unstubAllGlobals()
  })

  test('treats narrow browser viewports as mobile', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })

    const { result } = renderHook(() => useIsMobile())

    expect(result.current).toBe(true)
  })

  test('uses responsive layout in a narrow Electron host', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    installTestDesktopHost()

    const { result } = renderHook(() => useIsMobile())

    expect(result.current).toBe(true)
  })

  test('keeps a narrow Gateway Web viewport in mobile mode with an active Gateway transport', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    installTestTransport(() => null)
    Object.defineProperty(window, '__KCODER_GATEWAY_WEB_SHIM__', {
      configurable: true,
      value: true,
    })

    const { result } = renderHook(() => useIsMobile())

    expect(result.current).toBe(true)
  })
})
