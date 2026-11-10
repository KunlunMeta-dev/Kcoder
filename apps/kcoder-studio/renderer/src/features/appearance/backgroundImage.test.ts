import { describe, expect, test, vi } from 'vitest'
import { selectClientImage } from '@/lib/client-image'
import { backgroundImageUrl, removeWorkbenchBackground, selectWorkbenchBackground } from './backgroundImage'
vi.mock('@/lib/client-image', async original => ({
  ...(await original<typeof import('@/lib/client-image')>()), selectClientImage: vi.fn(),
}))
describe('client background images', () => {
  test('keeps selected images within the client preference', async () => {
    const image = 'data:image/webp;base64,UklGRg=='
    vi.mocked(selectClientImage).mockResolvedValue(image)
    await expect(selectWorkbenchBackground('common')).resolves.toBe(image)
    expect(backgroundImageUrl(image)).toBe(image)
    await removeWorkbenchBackground('common')
  })
  test('cancellation leaves the current background unchanged', async () => {
    vi.mocked(selectClientImage).mockResolvedValue(null)
    await expect(selectWorkbenchBackground('dark')).resolves.toBeNull()
    expect(backgroundImageUrl('/unscoped/target/image.png')).toBeNull()
  })
})
