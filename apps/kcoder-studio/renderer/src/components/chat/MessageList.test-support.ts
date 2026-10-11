import { fireEvent } from '@testing-library/react'

export function selectText(container: HTMLElement, text: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && !node.textContent?.includes(text)) node = walker.nextNode()
  if (!node) throw new Error(`Could not find text: ${text}`)
  const start = node.textContent!.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  setDocumentSelection(range)
}

export function firstTextNode(container: HTMLElement): Node {
  const node = document.createTreeWalker(container, NodeFilter.SHOW_TEXT).nextNode()
  if (!node) throw new Error('Could not find a text node')
  return node
}

export function setDocumentSelection(range: Range) {
  Object.defineProperty(range, 'getBoundingClientRect', {
    value: () => ({ left: 100, top: 100, width: 80, height: 20 }),
  })
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
}
