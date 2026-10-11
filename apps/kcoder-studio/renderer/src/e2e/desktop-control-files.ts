/** Synthetic file selection for the opt-in verification bridge. Never reads host paths. */
export function fillDesktopFileInput(input: HTMLInputElement, value: string): void {
  const limit = 512 * 1024
  if (value.length > limit || new TextEncoder().encode(value).length > limit)
    throw new Error('Verification file payload is too large')
  const files: unknown = JSON.parse(value)
  if (!Array.isArray(files) || files.length > 10) throw new Error('Invalid verification file list')
  const transfer = new DataTransfer()
  let total = 0
  for (const entry of files) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      /[\\/]/.test(entry.name) ||
      'path' in entry ||
      'uri' in entry ||
      (typeof entry.text === 'string') === (typeof entry.contentBase64 === 'string')
    )
      throw new Error(
        'Verification files require a basename and exactly one text or contentBase64 payload'
      )
    let bytes: Uint8Array<ArrayBuffer>
    if (typeof entry.text === 'string') {
      if ('contentBase64' in entry)
        throw new Error('Verification file payloads are mutually exclusive')
      bytes = new TextEncoder().encode(entry.text)
    } else {
      if (
        'text' in entry ||
        typeof entry.contentBase64 !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          entry.contentBase64
        )
      )
        throw new Error('Invalid verification file base64 payload')
      const binary = atob(entry.contentBase64)
      if (btoa(binary) !== entry.contentBase64)
        throw new Error('Invalid verification file base64 payload')
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    }
    total += bytes.length
    if (total > limit) throw new Error('Verification file payload is too large')
    transfer.items.add(
      new File([bytes], entry.name, {
        type: typeof entry.text === 'string' ? 'text/plain' : 'application/octet-stream',
      })
    )
  }
  // Validation is atomic: invalid later descriptors cannot change the input selection.
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
