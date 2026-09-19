import { isNativeTauriHost } from '@/lib/runtime-environment'
import { copyLocalExecutorDebugInfo } from '@/tauri/localExecutor'

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // The macOS WebView may reject the browser clipboard API; use the native command below.
  }

  if (isNativeTauriHost()) {
    await copyLocalExecutorDebugInfo(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  const focus = document.activeElement
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange()
      )
    : []
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy'))
      throw new Error('Clipboard access was denied')
  } finally {
    textarea.remove()
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true })
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
  }
}
