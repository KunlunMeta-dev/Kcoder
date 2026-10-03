/** Synthetic file selection for the opt-in verification bridge. Never reads host paths. */
export function fillDesktopFileInput(input: HTMLInputElement, value: string): void {
  if (value.length > 512 * 1024) throw new Error('Verification file payload is too large')
  const files: unknown = JSON.parse(value)
  if (!Array.isArray(files) || files.length > 10) throw new Error('Invalid verification file list')
  const transfer = new DataTransfer()
  for (const entry of files) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      typeof entry.text !== 'string' ||
      /[\\/]/.test(entry.name)
    )
      throw new Error('Verification files require a basename and text content')
    transfer.items.add(new File([entry.text], entry.name, { type: 'text/plain' }))
  }
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
