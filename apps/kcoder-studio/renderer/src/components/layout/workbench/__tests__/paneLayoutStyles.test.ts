import { describe, expect, test } from 'vitest'
import {
  DESKTOP_CHAT_CONTENT_BASE_CLASS,
  DESKTOP_CHAT_CONTENT_COLUMN_WIDTH_CLASS,
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
  DESKTOP_MESSAGE_LIST_WIDTH_CLASS,
  DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
} from '../paneLayoutStyles'

// The column width may be overridden through `--kcoder-chat-column-width`; the
// default column is the CSS variable fallback.
const COLUMN_WIDTH_PATTERN =
  /w-\[min\((?:var\(--kcoder-chat-column-width,([\d.]+)rem\)|([\d.]+)rem),calc\(100%_-_2rem\)\)\]/

function columnRem(classNames: string): number {
  const match = COLUMN_WIDTH_PATTERN.exec(classNames)
  if (!match) throw new Error(`missing desktop column width in "${classNames}"`)
  return Number(match[1] ?? match[2])
}

describe('desktop chat pane layout styles', () => {
  test('uses a reading column 30% wider than the base 46rem column', () => {
    expect(columnRem(DESKTOP_CHAT_CONTENT_COLUMN_WIDTH_CLASS)).toBe(59.8)
    expect(columnRem(DESKTOP_CHAT_CONTENT_WIDTH_CLASS)).toBeCloseTo(46 * 1.3, 5)
  })

  test('keeps the composer and the message list on the same widened column', () => {
    expect(columnRem(DESKTOP_MESSAGE_LIST_WIDTH_CLASS)).toBe(59.8)
    expect(columnRem(DESKTOP_MESSAGE_LIST_CLASS)).toBe(59.8)
    expect(columnRem(DESKTOP_STICKY_COMPOSER_LAYER_CLASS)).toBe(59.8)
  })

  test('keeps the pane gutter clamp and the centering transition', () => {
    expect(DESKTOP_CHAT_CONTENT_WIDTH_CLASS).toContain('max-w-[calc(100%_-_2rem)]')
    expect(DESKTOP_CHAT_CONTENT_WIDTH_CLASS).toContain(DESKTOP_CHAT_CONTENT_BASE_CLASS)
    expect(DESKTOP_CHAT_CONTENT_BASE_CLASS).toContain('mx-auto')
    expect(DESKTOP_CHAT_CONTENT_BASE_CLASS).toContain('min-w-0')
    expect(DESKTOP_CHAT_CONTENT_BASE_CLASS).toContain('transition-[width,max-width]')
  })
})
