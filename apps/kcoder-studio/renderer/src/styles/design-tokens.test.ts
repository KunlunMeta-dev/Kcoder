import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import tailwindColors from 'tailwindcss/colors.js'
import tailwindConfig from '../../tailwind.config.js'

// Studio's design tokens are declared as CSS custom properties in globals.css
// and surfaced to components by tailwind.config.js. A token that is declared on
// only one side silently does nothing: Tailwind emits no utility, so the class
// in the JSX is inert. That is how `ring-focus`, `text-destructive` and
// `text-muted-foreground` came to be used across Studio without ever rendering.
// These tests keep both sides in step.

const RENDERER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GLOBALS_CSS = path.join(RENDERER_ROOT, 'src', 'styles', 'globals.css')
const SOURCE_ROOT = path.join(RENDERER_ROOT, 'src')

const extend = tailwindConfig.theme.extend

/**
 * Colour names Tailwind can resolve for a colour utility. `bg-base` is declared
 * under `extend.backgroundColor` rather than `extend.colors`, so both are
 * collected.
 */
function wiredColorNames(): Set<string> {
  return new Set([...Object.keys(extend.colors), ...Object.keys(extend.backgroundColor)])
}

/**
 * Semantic colour aliases Studio owns. Each must exist in both themes, which
 * DESIGN.md 4.1 states as a hard requirement. The set follows DESIGN.md 4.2,
 * which defines exactly four status roles — success (green), warning (orange),
 * destructive (red) and the reserved purple — plus the blue interactive
 * accent. There is deliberately no `info` status colour.
 */
const SEMANTIC_COLORS = [
  'focus',
  'accent-surface',
  'foreground',
  'muted-foreground',
  'success',
  'success-contrast',
  'warning',
  'warning-contrast',
  'destructive',
  'destructive-contrast',
  'surface-hover',
  'overlay',
]

/** Non-colour scales that must stay declared in CSS and wired into Tailwind. */
const SEMANTIC_SCALES: Array<{ group: 'borderRadius' | 'height' | 'transitionDuration' | 'transitionTimingFunction'; cssVar: string; key: string }> = [
  { group: 'borderRadius', cssVar: 'radius-sm', key: 'sm' },
  { group: 'borderRadius', cssVar: 'radius-inner', key: 'inner' },
  { group: 'borderRadius', cssVar: 'radius-checkbox', key: 'checkbox' },
  { group: 'borderRadius', cssVar: 'radius-md', key: 'md' },
  { group: 'borderRadius', cssVar: 'radius-lg', key: 'lg' },
  { group: 'borderRadius', cssVar: 'radius-row', key: 'row' },
  { group: 'borderRadius', cssVar: 'radius-xl', key: 'xl' },
  { group: 'borderRadius', cssVar: 'radius-2xl', key: '2xl' },
  { group: 'borderRadius', cssVar: 'radius-dialog', key: 'dialog' },
  { group: 'borderRadius', cssVar: 'radius-3xl', key: '3xl' },
  { group: 'borderRadius', cssVar: 'radius-full', key: 'full' },
  { group: 'height', cssVar: 'control-height-sm', key: 'control-sm' },
  { group: 'height', cssVar: 'control-height-md', key: 'control-md' },
  { group: 'height', cssVar: 'control-height-lg', key: 'control-lg' },
  { group: 'height', cssVar: 'control-height-xl', key: 'control-xl' },
  { group: 'transitionDuration', cssVar: 'duration-fast', key: 'fast' },
  { group: 'transitionDuration', cssVar: 'duration-base', key: 'DEFAULT' },
  { group: 'transitionDuration', cssVar: 'duration-slow', key: 'slow' },
  { group: 'transitionTimingFunction', cssVar: 'ease-standard', key: 'standard' },
]

/**
 * Suffixes of the colour-capable utilities below that are not colours. Kept
 * explicit so that a genuinely undefined colour fails the scan instead of being
 * absorbed into a wildcard.
 */
const NON_COLOR_SUFFIXES = new Set([
  // type scale
  'xs', 'sm', 'md', 'lg', 'xl', 'heading-sm', 'heading-md', 'heading-lg', 'chat', 'code', 'code-sm',
  // alignment / wrap / overflow
  'left', 'center', 'right', 'ellipsis',
  // sides and widths
  'b', 't', 'l', 'r', 'x', 'y',
  // border / outline / decoration styles
  'none', 'dashed', 'dotted', 'collapse', 'inset', 'box', 'offset-2',
  // gradients
  'gradient-to-t', 'gradient-to-r', 'gradient-to-br',
  // fragments of CSS declarations that live in inline style objects
  'radius', 'color', 'bottom',
])

/**
 * Colour utilities used by Studio that Tailwind cannot currently generate.
 * Each entry is outstanding migration work, not an accepted name; the scan
 * fails on anything that is not listed here so new dead tokens cannot land.
 */
const KNOWN_UNDEFINED_COLOR_UTILITIES: Record<string, string> = {
  danger: 'used by WorktreeBranchSelector.tsx; migrate to `destructive`',
}

function customPropertiesIn(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`globals.css: selector ${selector} not found`)
  const end = css.indexOf('\n}', start)
  if (end < 0) throw new Error(`globals.css: unterminated block for ${selector}`)
  const properties = new Map<string, string>()
  for (const match of css.slice(start, end).matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)) {
    properties.set(match[1], match[2].trim())
  }
  return properties
}

/**
 * Comments discuss token names in prose, so they must not be scanned as if the
 * names were utilities. Only `//` preceded by whitespace is treated as a line
 * comment, which keeps `https://` inside string literals intact.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    // Tests and test-support modules embed fixture strings that look like
    // class names, so only shipped components are scanned.
    else if (/\.tsx$/.test(entry.name) && !/\.test\.|test-support/.test(entry.name)) found.push(full)
  }
  return found
}

const globalsCss = fs.readFileSync(GLOBALS_CSS, 'utf-8')

test('semantic colour tokens are defined in both themes and wired into Tailwind', () => {
  const light = customPropertiesIn(globalsCss, ':root')
  const dark = customPropertiesIn(globalsCss, "[data-theme='dark']")
  const wired = wiredColorNames()
  const problems: string[] = []

  for (const name of SEMANTIC_COLORS) {
    if (!light.has(`color-${name}`)) problems.push(`--color-${name} missing from :root`)
    if (!dark.has(`color-${name}`)) problems.push(`--color-${name} missing from [data-theme='dark']`)
    if (!wired.has(name)) problems.push(`colour "${name}" missing from tailwind.config.js extend.colors`)
  }

  expect(problems).toEqual([])
})

test('radius, control-height and motion tokens are defined and wired', () => {
  const light = customPropertiesIn(globalsCss, ':root')
  const problems: string[] = []

  for (const { group, cssVar, key } of SEMANTIC_SCALES) {
    if (!light.has(cssVar)) problems.push(`--${cssVar} missing from :root`)
    if (!(key in extend[group])) problems.push(`${group}.${key} missing from tailwind.config.js`)
  }

  expect(problems).toEqual([])
})

test('no component uses a colour utility that Tailwind cannot generate', () => {
  const palette = new Set<string>()
  for (const [name, value] of Object.entries(tailwindColors)) {
    if (typeof value === 'string') palette.add(name)
    else if (value && typeof value === 'object') {
      for (const shade of Object.keys(value)) palette.add(`${name}-${shade}`)
    }
  }
  const wired = wiredColorNames()

  const prefixes = 'ring-offset|ring|border|text|bg|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow'
  const utility = new RegExp(`(?:^|[\\s"\`=:(])(?:${prefixes})-[a-z][a-z0-9]*(?:-[a-z0-9]+)*`, 'g')
  const unresolved = new Map<string, Set<string>>()

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = stripComments(fs.readFileSync(file, 'utf-8'))
    for (const match of source.matchAll(utility)) {
      const raw = match[0].replace(/^[\s"`=:(]/, '')
      // `stroke-width="2"` is an SVG attribute, not a utility.
      if (source[match.index + match[0].length] === '=') continue

      let suffix = raw.startsWith('ring-offset-')
        ? raw.slice('ring-offset-'.length)
        : raw.slice(raw.indexOf('-') + 1)
      // `border-t-text-muted` names a colour; `border-t-2` names a width.
      suffix = suffix.replace(/^(?:x|y|t|r|b|l|s|e)-/, '')
      if (/^\d+$/.test(suffix)) continue
      if (palette.has(suffix) || wired.has(suffix) || NON_COLOR_SUFFIXES.has(suffix)) continue

      const where = `${path.relative(RENDERER_ROOT, file)}:${raw}`
      if (!unresolved.has(suffix)) unresolved.set(suffix, new Set())
      unresolved.get(suffix)!.add(where)
    }
  }

  const unexpected = [...unresolved.entries()]
    .filter(([name]) => !(name in KNOWN_UNDEFINED_COLOR_UTILITIES))
    .map(([name, usages]) => `${name} (${[...usages].join(', ')})`)

  expect(unexpected).toEqual([])
})

test('settings surfaces take their focus ring from the token, not a literal blue', () => {
  // DESIGN.md 3.5 and 10: keyboard focus is the semantic blue token, and
  // `ring-blue-500` is a near-miss palette default (#3B82F6, not #339CFF)
  // that was written inline across the settings pages.
  //
  // Only focus-variant chains are checked. Blue used for hover or a selected
  // state is a permitted interactive accent under 4.2, and renaming those to
  // the focus token would misdescribe them.
  const roots = [
    path.join(SOURCE_ROOT, 'components', 'settings'),
    path.join(SOURCE_ROOT, 'features', 'appearance'),
  ]
  // Owned by another team; its focus ring is migrated with the model settings
  // work rather than edited across the ownership boundary.
  const ownedElsewhere = new Set(['KCoderProviderSettingsPage.tsx'])
  const offenders: string[] = []

  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      if (ownedElsewhere.has(path.basename(file))) continue
      const source = stripComments(fs.readFileSync(file, 'utf-8'))
      for (const match of source.matchAll(
        /(?:[\w-]*focus[\w-]*:)+(?:ring|border|outline)-blue-500(?:\/\d+)?/g
      )) {
        offenders.push(`${path.relative(RENDERER_ROOT, file)}:${match[0]}`)
      }
    }
  }

  expect(offenders).toEqual([])
})

test('known undefined colour utilities are still present, so the debt list cannot rot', () => {
  const sources = sourceFiles(SOURCE_ROOT).map(file => stripComments(fs.readFileSync(file, 'utf-8')))
  // Guards the entry above: once the migration lands the allowlist must go too.
  const stillUsed = sources.some(source => /(?:^|[\s"'`=:(])(?:[\w-]+:)*(?:ring|border|text|bg|fill|stroke|divide|outline|decoration)-danger\b/.test(source))
  expect(stillUsed).toBe(Object.keys(KNOWN_UNDEFINED_COLOR_UTILITIES).length > 0)
})
