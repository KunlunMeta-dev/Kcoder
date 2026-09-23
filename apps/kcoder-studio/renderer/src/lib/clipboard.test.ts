import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'
import { isNativeTauriHost } from './runtime-environment'
import { copyLocalExecutorDebugInfo } from '@/tauri/localExecutor'

vi.mock('./runtime-environment', () => ({ isNativeTauriHost: vi.fn(() => false) }))
vi.mock('@/tauri/localExecutor', () => ({ copyLocalExecutorDebugInfo: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isNativeTauriHost).mockReturnValue(false)
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

test('Gateway fallback copies the exact text and restores focus without invoking a native shim', async () => {
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  const copy = vi.fn(() => {
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('  exact text\n')
    return true
  })
  Object.defineProperty(document, 'execCommand', { value: copy, configurable: true })
  await copyTextToClipboard('  exact text\n')
  expect(copy).toHaveBeenCalledWith('copy')
  expect(copyLocalExecutorDebugInfo).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(input)
  expect(document.querySelector('textarea')).toBeNull()
})

test('a rejected fallback is not a copied success and still removes the temporary element', async () => {
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
  await expect(copyTextToClipboard('text')).rejects.toThrow('denied')
  expect(document.querySelector('textarea')).toBeNull()
})

test('an actual Tauri host keeps its native clipboard fallback', async () => {
  vi.mocked(isNativeTauriHost).mockReturnValue(true)
  await copyTextToClipboard('native')
  expect(copyLocalExecutorDebugInfo).toHaveBeenCalledWith('native')
})
