import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import {
  PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS,
  PAGE_CONTENT_NARROW_COLUMN_MAX_WIDTH_CLASS,
  PageContent,
} from '../page-content'

const GLOBALS_CSS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../styles/globals.css'
)

// Resolve a `:root` custom property so tokens such as
// `max-w-[var(--studio-page-column-width)]` are measured by their real value.
function rootCustomProperty(name: string): string {
  const css = fs.readFileSync(GLOBALS_CSS, 'utf-8')
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
  if (!match) throw new Error(`missing ${name} in globals.css`)
  return match[1].trim()
}

function remWidth(classNames: string): number {
  const variable = /max-w-\[var\((--[\w-]+)\)\]/.exec(classNames)
  if (variable) return remWidth(`max-w-[${rootCustomProperty(variable[1])}]`)
  const rem = /max-w-\[([\d.]+)rem\]/.exec(classNames)
  if (rem) return Number(rem[1])
  const px = /max-w-\[(\d+)px\]/.exec(classNames)
  if (px) return Number(px[1]) / 16
  throw new Error(`no column width in "${classNames}"`)
}

describe('PageContent shared column', () => {
  test('uses the shared reading/configuration column widened by 30%', () => {
    // `48rem` (`768px`) is the pre-widening column this token replaced.
    expect(remWidth(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS)).toBeCloseTo(48 * 1.3, 5)

    render(<PageContent data-testid="page-content">body</PageContent>)

    expect(screen.getByTestId('page-content')).toHaveClass(
      PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS,
      'mx-auto',
      'w-full',
      'min-w-0'
    )
  })

  test('keeps the narrow variant proportionally narrower than the standard column', () => {
    // `560px` is the pre-widening narrow column.
    expect(remWidth(PAGE_CONTENT_NARROW_COLUMN_MAX_WIDTH_CLASS)).toBeCloseTo((560 * 1.3) / 16, 5)
    expect(remWidth(PAGE_CONTENT_NARROW_COLUMN_MAX_WIDTH_CLASS)).toBeLessThan(
      remWidth(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS)
    )

    render(
      <PageContent width="narrow" data-testid="narrow-content">
        body
      </PageContent>
    )

    const narrow = screen.getByTestId('narrow-content')
    expect(narrow).toHaveClass(PAGE_CONTENT_NARROW_COLUMN_MAX_WIDTH_CLASS)
    expect(narrow).not.toHaveClass(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS)
  })

  test('renders as a section when requested and keeps caller classes', () => {
    render(
      <PageContent as="section" className="pb-10" data-testid="section-content">
        body
      </PageContent>
    )

    const content = screen.getByTestId('section-content')
    expect(content.tagName).toBe('SECTION')
    expect(content).toHaveClass(PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS, 'pb-10')
  })
})
