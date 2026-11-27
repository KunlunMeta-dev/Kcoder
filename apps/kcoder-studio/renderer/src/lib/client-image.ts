// Client-only image preferences never upload files to a Gateway or model.
export type ClientImageKind = 'background' | 'avatar'

export function isClientImageUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 350 * 1024 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
}

export async function prepareClientImage(file: File, kind: ClientImageKind): Promise<string> {
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new Error('Image must be smaller than 10 MiB')
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => header[i] === value)
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255
  const webp =
    String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
  if (!png && !jpeg && !webp) throw new Error('Choose a PNG, JPEG or WebP image')
  const bitmap = await createImageBitmap(file)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000)
      throw new Error('Image dimensions are too large')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable')
    let edge = kind === 'avatar' ? 256 : 1920
    const limit = kind === 'avatar' ? 64 * 1024 : 300 * 1024
    while (edge >= 128) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.85, 0.65, 0.45]) {
        const result = canvas.toDataURL('image/webp', quality)
        if (result.length <= limit && isClientImageUrl(result)) return result
      }
      edge = Math.floor(edge * 0.7)
    }
    throw new Error('Image could not be reduced to a safe preference size')
  } finally {
    bitmap.close()
  }
}

export function selectClientImage(kind: ClientImageKind): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.style.display = 'none'
    input.setAttribute('data-testid', 'client-image-file-input')
    document.body.appendChild(input)
    const cleanup = () => input.remove()
    input.addEventListener(
      'cancel',
      () => {
        cleanup()
        resolve(null)
      },
      { once: true }
    )
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0]
        cleanup()
        if (!file) {
          resolve(null)
          return
        }
        void prepareClientImage(file, kind).then(resolve, reject)
      },
      { once: true }
    )
    input.click()
  })
}
