import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'
import { gatewayServerLabel, runtimeProjectLabel } from './gatewayServerLabel'
import {
  editRuntimeTargetSession,
  runtimeTargetConfigFromDraft,
} from '@/components/settings/runtime-target-model'

describe('runtime target display names', () => {
  it('localizes only explicit application-owned labels and preserves configured names', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'en',
      resources: {
        en: { common: { runtimeTarget: { currentComputer: 'This computer' } } },
        'zh-CN': { common: { runtimeTarget: { currentComputer: '当前计算机' } } },
      },
    })
    expect(runtimeProjectLabel({ name: '当前计算机' }, i18n.t)).toBe('当前计算机')
    expect(runtimeProjectLabel({ name: '当前计算机', nameKey: 'currentComputer' }, i18n.t)).toBe('This computer')
    const custom = { id: 'local', label: '当前计算机', transport: 'local' as const }
    expect(gatewayServerLabel(custom, i18n.t)).toBe('当前计算机')
    const builtIn = { ...custom, labelKey: 'currentComputer' as const }
    expect(gatewayServerLabel(builtIn, i18n.t)).toBe('This computer')
    await i18n.changeLanguage('zh-CN')
    expect(gatewayServerLabel(builtIn, i18n.t)).toBe('当前计算机')
    const session = editRuntimeTargetSession({ ...builtIn, runtime: 'kcoder', description: '' })
    expect(runtimeTargetConfigFromDraft(session).labelKey).toBe('currentComputer')
    session.draft = { ...session.draft, label: 'My workstation' }
    expect(runtimeTargetConfigFromDraft(session).labelKey).toBeUndefined()
  })
})
