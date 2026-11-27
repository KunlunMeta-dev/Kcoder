import i18n from '@/i18n'
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, imageSizeIssue } from '../../../shared/attachmentImagePolicy'
export { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, SMALL_IMAGE_EDGE, imageSizeIssue } from '../../../shared/attachmentImagePolicy'
export async function inspectImageFile(
  file: File,
  signal?: AbortSignal
): Promise<{ image_width: number; image_height: number } | null> {
  if (
    !file.type.startsWith('image/') &&
    !/\.(png|jpe?g|gif|webp|bmp|avif|apng|svg)$/i.test(file.name)
  )
    return null
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error(
      i18n.t('common:imageFeedback.fileLarge', {
        size: (file.size / 1024 / 1024).toFixed(1),
        max: 10,
      })
    )
  if (signal?.aborted) throw new Error('Upload cancelled')
  const url = URL.createObjectURL(file)
  try {
    const dimensions = await new Promise<{ image_width: number; image_height: number }>(
      (resolve, reject) => {
        const image = new Image()
        const done = (error?: Error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          image.onload = null
          image.onerror = null
          if (error) {
            image.src = ''
            reject(error)
          } else resolve({ image_width: image.naturalWidth, image_height: image.naturalHeight })
        }
        const abort = () => done(new Error('Upload cancelled'))
        const timer = setTimeout(
          () => done(new Error(i18n.t('common:imageFeedback.invalid'))),
          10000
        )
        image.onload = () =>
          image.naturalWidth > 0 && image.naturalHeight > 0
            ? done()
            : done(new Error(i18n.t('common:imageFeedback.invalid')))
        image.onerror = () => done(new Error(i18n.t('common:imageFeedback.invalid')))
        signal?.addEventListener('abort', abort, { once: true })
        image.src = url
      }
    )
    if (imageSizeIssue(dimensions.image_width, dimensions.image_height) === 'large') {
      throw new Error(
        i18n.t('common:imageFeedback.large', {
          width: dimensions.image_width,
          height: dimensions.image_height,
          maxEdge: MAX_IMAGE_EDGE,
          maxPixels: MAX_IMAGE_PIXELS,
        })
      )
    }
    return dimensions
  } finally {
    URL.revokeObjectURL(url)
  }
}
