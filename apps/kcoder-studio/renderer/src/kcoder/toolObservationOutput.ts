/** Preserve bounded screenshot observations alongside the existing textual result. */
export function toolObservationOutput(item: Record<string, unknown>): unknown {
  const raw = item.outputImages
  if (!Array.isArray(raw) || raw.length === 0)
    return item.outputImagesOmitted === true
      ? { output: item.output, images: [], imagesOmitted: true }
      : item.output
  let total = 0
  let omitted = item.outputImagesOmitted === true
  const images: Array<{ mimeType: string; data: string }> = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') {
      omitted = true
      continue
    }
    const { mimeType, data } = value as Record<string, unknown>
    if (
      typeof mimeType !== 'string' ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType) ||
      typeof data !== 'string' ||
      data.length === 0 ||
      total + data.length > 1024 * 1024 ||
      images.length >= 16 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
      omitted = true
      continue
    }
    total += data.length
    images.push({ mimeType, data })
  }
  return { output: item.output, images, imagesOmitted: omitted }
}

export function hasToolImageObservations(output: unknown): boolean {
  return (
    !!output &&
    typeof output === 'object' &&
    (Array.isArray((output as Record<string, unknown>).images) ||
      (output as Record<string, unknown>).imagesOmitted === true)
  )
}
