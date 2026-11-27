import { afterEach, expect, test, vi } from 'vitest'
import { imageSizeIssue, inspectImageFile } from './imageValidation'
vi.mock('@/i18n', () => ({
  default: { t: (key: string, values: unknown) => `${key} ${JSON.stringify(values)}` },
}))
afterEach(() => vi.unstubAllGlobals())
function browserImage(width: number, height: number) {
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:owned', revokeObjectURL: revoke })
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = width
      naturalHeight = height
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.())
      }
    }
  )
  return revoke
}
test('large dimensions are rejected before upload with actual dimensions and URL cleanup', async () => {
  const revoke = browserImage(9000, 500)
  await expect(
    inspectImageFile(new File(['fixture'], 'large.png', { type: 'image/png' }))
  ).rejects.toThrow('9000')
  expect(revoke).toHaveBeenCalledWith('blob:owned')
})
test('small images are retained and normal desktop captures are accepted', async () => {
  const revoke = browserImage(16, 24)
  expect(await inspectImageFile(new File(['fixture'], 'icon.png', { type: 'image/png' }))).toEqual({
    image_width: 16,
    image_height: 24,
  })
  expect(revoke).toHaveBeenCalledOnce()
  expect(imageSizeIssue(16, 24)).toBe('small')
  expect(imageSizeIssue(3840, 2160)).toBeNull()
  expect(imageSizeIssue(8192, 8192)).toBe('large')
})
test('byte budget rejects oversized files before creating a browser image', async () => {
  const revoke = browserImage(100, 100)
  const file = new File(['fixture'], 'large.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })
  await expect(inspectImageFile(file)).rejects.toThrow('fileLarge')
  expect(revoke).not.toHaveBeenCalled()
})
test('non-images bypass image inspection', async () => {
  expect(await inspectImageFile(new File(['text'], 'note.txt', { type: 'text/plain' }))).toBeNull()
})
