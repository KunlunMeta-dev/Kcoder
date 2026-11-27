const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
}

export function hexToRgbTriplet(hex: string): string {
  const normalized = hex.replace('#', '')
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map(char => `${char}${char}`)
          .join('')
      : normalized

  const red = parseInt(expanded.slice(0, 2), 16)
  const green = parseInt(expanded.slice(2, 4), 16)
  const blue = parseInt(expanded.slice(4, 6), 16)

  return `${red} ${green} ${blue}`
}

export function clampContrast(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 50
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function blendTriplet(value: string, target: string, weight: number): string {
  const [channels, alpha] = value.split('/').map(part => part.trim())
  const source = channels.split(/\s+/).map(Number)
  const destination = target.split('/')[0].trim().split(/\s+/).map(Number)
  if (
    source.length !== 3 ||
    destination.length !== 3 ||
    [...source, ...destination].some(value => !Number.isFinite(value))
  )
    return value
  const mixed = source
    .map((value, i) => Math.round(value + (destination[i] - value) * weight))
    .join(' ')
  return alpha ? `${mixed} / ${alpha}` : mixed
}
