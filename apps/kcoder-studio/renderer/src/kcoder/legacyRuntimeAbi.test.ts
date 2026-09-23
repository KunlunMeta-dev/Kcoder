import { describe, expect, test } from 'vitest'
import {
  KCODER_RUNTIME_METHODS,
  isKCoderRuntimeMethod,
  runtimeMethodForCurrentHost,
  runtimeNameForCurrentHost,
} from './legacyRuntimeAbi'

describe('Wework 遗留 runtime ABI 边界', () => {
  test('KCoder 宿主只产生 KCoder 业务名称和通用方法', () => {
    const gatewayDocument = {
      querySelector: () => document.createElement('meta'),
    }

    expect(runtimeNameForCurrentHost(gatewayDocument)).toBe('kcoder')
    expect(runtimeMethodForCurrentHost('modelsList', gatewayDocument)).toBe(
      KCODER_RUNTIME_METHODS.modelsList
    )
  })

  test('只在本模块识别 Wework 尚未迁移的 Codex 方法别名', () => {
    expect(isKCoderRuntimeMethod('runtime.codex.models.list', 'modelsList')).toBe(true)
    expect(isKCoderRuntimeMethod('runtime.codex.unknown', 'modelsList')).toBe(false)
  })

  test('非 KCoder 的上游 Tauri 宿主继续使用其原生 ABI', () => {
    const upstreamDocument = { querySelector: () => null }

    expect(runtimeNameForCurrentHost(upstreamDocument)).toBe('codex')
    expect(runtimeMethodForCurrentHost('modelsList', upstreamDocument)).toBe(
      'runtime.codex.models.list'
    )
  })
})
