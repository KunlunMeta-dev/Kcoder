// The opt-in file bridge creates synthetic files, never reads local paths.
import { beforeEach, expect, test, vi } from 'vitest'
import { fillDesktopFileInput } from './desktop-control-files'
beforeEach(() => {
  vi.stubGlobal(
    'DataTransfer',
    class {
      files: File[] = []
      items = { add: (file: File) => this.files.push(file) }
    }
  )
})
const input = () => ({ files: null, dispatchEvent: vi.fn() }) as unknown as HTMLInputElement
async function bytes(file: File) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}
test('preserves UTF-8 text and arbitrary binary bytes in the same synthetic selection', async () => {
  const element = input()
  fillDesktopFileInput(
    element,
    JSON.stringify([
      { name: 'text.txt', text: '中文' },
      { name: 'part.kwiki', contentBase64: btoa('\x00\xff\x80binary') },
    ])
  )
  expect(element.files?.length).toBe(2)
  expect([...(await bytes(element.files![1]))]).toEqual([
    0,
    255,
    128,
    ...new TextEncoder().encode('binary'),
  ])
  expect(element.dispatchEvent).toHaveBeenCalledTimes(2)
})
test('rejects ambiguous payloads, noncanonical base64, host paths and quotas atomically', () => {
  for (const descriptor of [
    { name: 'data', text: 'x', contentBase64: 'eA==' },
    { name: 'data', contentBase64: 'Zh==' },
    { name: 'data', contentBase64: 'not base64' },
    { name: 'data', text: 'x', path: '/etc/passwd' },
    { name: '../escape', text: 'x' },
  ]) {
    const element = input()
    expect(() =>
      fillDesktopFileInput(element, JSON.stringify([{ name: 'safe', text: 'x' }, descriptor]))
    ).toThrow()
    expect(element.files).toBeNull()
    expect(element.dispatchEvent).not.toHaveBeenCalled()
  }
  expect(() =>
    fillDesktopFileInput(
      input(),
      JSON.stringify(Array.from({ length: 11 }, () => ({ name: 'data', text: 'x' })))
    )
  ).toThrow()
  expect(() =>
    fillDesktopFileInput(input(), JSON.stringify([{ name: 'data', text: '中'.repeat(200000) }]))
  ).toThrow('too large')
})
