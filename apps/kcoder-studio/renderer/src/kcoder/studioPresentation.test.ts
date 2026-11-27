import { beforeEach, describe, expect, it } from 'vitest'
import '@/i18n'
import { studioCreationParams, studioPresentationParams } from './studioPresentation'
import { nativeIsolatedWidgetsAvailable, nativeMcpAppBridgeAvailable } from './nativeWidgetCapabilities'
import { setInlineWidgetsEnabled } from '@/features/workbench/studioWorkMode'
import type { GatewayClient } from './gatewayRuntimeTypes'

function client(capabilities: string[]): GatewayClient {
  return { supportsExperimental: cap => capabilities.includes(cap) } as GatewayClient
}

describe('Studio work-mode presentation', () => {
  beforeEach(() => localStorage.clear())
  it('preserves compatibility without silently downgrading requested office mode', () => {
    const legacy = client([])
    expect(studioCreationParams({}, legacy)).toEqual({})
    expect(studioPresentationParams('kcoder', legacy)).toEqual({})
    expect(() => studioCreationParams({ studioWorkMode: 'kworker' }, legacy)).toThrow()
    expect(() => studioPresentationParams('kworker', legacy)).toThrow()
  })
  it('keeps mode separate from visualization preference and special session modes', () => {
    const studio = client(['studioWorkModesV1', 'inlineWidgetsV1'])
    expect(studioCreationParams({ studioWorkMode: 'kworker' }, studio)).toEqual({
      studioWorkMode: 'kworker',
    })
    expect(
      studioCreationParams({ studioWorkMode: 'kworker', sessionMode: 'workflow_draft' }, studio)
    ).toEqual({})
    expect(studioPresentationParams('kworker', studio)).toEqual({
      clientPresentation: { version: 1, studioWorkMode: 'kworker', inlineWidgets: true },
    })
    setInlineWidgetsEnabled(false)
    expect(studioPresentationParams('kworker', studio)).toEqual({
      clientPresentation: { version: 1, studioWorkMode: 'kworker', inlineWidgets: false },
    })
    expect(studioCreationParams({ studioWorkMode: 'kcoder' }, studio)).toEqual({ studioWorkMode: 'kcoder' })
    expect(studioPresentationParams('kcoder', studio)).toEqual({
      clientPresentation: { version: 1, studioWorkMode: 'kcoder', inlineWidgets: false },
    })
  })
  it('enables scripts only for an independently negotiated native host, respecting the user preference', async () => {
    expect(await nativeIsolatedWidgetsAvailable()).toBe(false)
    const studio = client(['studioWorkModesV1', 'inlineWidgetsV1', 'isolatedWidgetsV1'])
    expect(studioPresentationParams('kcoder', studio)).toEqual({
      clientPresentation: { version: 1, studioWorkMode: 'kcoder', inlineWidgets: true },
    })
    expect(studioPresentationParams('kworker', studio).clientPresentation?.isolatedWidgets).toBe(true)
    setInlineWidgetsEnabled(false)
    expect(studioPresentationParams('kworker', studio).clientPresentation?.isolatedWidgets).toBeUndefined()
    expect(studioPresentationParams('kcoder', studio).clientPresentation?.isolatedWidgets).toBeUndefined()
  })

  it.each(['kcoder', 'kworker'] as const)(
    '%s enables managed widgets by default only when negotiated and preserves an explicit opt-out',
    mode => {
      const studio = client(['studioWorkModesV1', 'inlineWidgetsV1'])
      expect(studioPresentationParams(mode, studio)).toEqual({
        clientPresentation: { version: 1, studioWorkMode: mode, inlineWidgets: true },
      })
      expect(studioPresentationParams(mode, client(['studioWorkModesV1']))).toEqual({
        clientPresentation: { version: 1, studioWorkMode: mode, inlineWidgets: false },
      })
      setInlineWidgetsEnabled(false)
      expect(studioPresentationParams(mode, studio)).toEqual({
        clientPresentation: { version: 1, studioWorkMode: mode, inlineWidgets: false },
      })
    }
  )
})

it('MCP Apps opt-in requires the full native lease bridge rather than a host-name or partial API', () => {
  const hostWindow = window as Window & { kcoderDesktopHost?: { widgets?: Record<string, unknown> } }
  const prior = hostWindow.kcoderDesktopHost
  try {
    delete hostWindow.kcoderDesktopHost
    expect(nativeMcpAppBridgeAvailable()).toBe(false)
    hostWindow.kcoderDesktopHost = { widgets: { getCapabilities: async () => ({ isolatedHtml: true }) } }
    expect(nativeMcpAppBridgeAvailable()).toBe(false)
    hostWindow.kcoderDesktopHost = { widgets: Object.fromEntries(['getCapabilities', 'authorize', 'heartbeat', 'revoke', 'onRevoked'].map(name => [name, () => {}])) }
    expect(nativeMcpAppBridgeAvailable()).toBe(true)
  } finally {
    if (prior) hostWindow.kcoderDesktopHost = prior
    else delete hostWindow.kcoderDesktopHost
  }
})
