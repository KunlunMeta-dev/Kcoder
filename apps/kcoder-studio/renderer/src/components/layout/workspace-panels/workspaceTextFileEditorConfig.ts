import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { c, cpp, java } from '@codemirror/legacy-modes/mode/clike'
import { go } from '@codemirror/legacy-modes/mode/go'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { xml } from '@codemirror/legacy-modes/mode/xml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { HighlightStyle, StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'

export type WorkspaceEditorLanguage =
  | 'javascript'
  | 'json'
  | 'css'
  | 'html'
  | 'xml'
  | 'markdown'
  | 'python'
  | 'rust'
  | 'yaml'
  | 'sql'
  | 'c'
  | 'cpp'
  | 'go'
  | 'java'
  | 'plain-text'

export function languageNameForPath(path: string): WorkspaceEditorLanguage {
  const extension = path.split('.').pop()?.toLowerCase()
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(extension ?? '')) {
    return 'javascript'
  }
  if (extension === 'json') return 'json'
  if (extension === 'css') return 'css'
  if (['html', 'htm'].includes(extension ?? '')) return 'html'
  if (['svg', 'xml'].includes(extension ?? '')) return 'xml'
  if (['md', 'markdown'].includes(extension ?? '')) return 'markdown'
  if (extension === 'py') return 'python'
  if (extension === 'rs') return 'rust'
  if (['yaml', 'yml'].includes(extension ?? '')) return 'yaml'
  if (extension === 'sql') return 'sql'
  if (extension === 'c') return 'c'
  if (['cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx'].includes(extension ?? '')) return 'cpp'
  if (extension === 'go') return 'go'
  if (extension === 'java') return 'java'
  return 'plain-text'
}

export function languageForPath(path: string): Extension {
  const extension = path.split('.').pop()?.toLowerCase()
  switch (languageNameForPath(path)) {
    case 'javascript':
      return javascript({
        jsx: extension?.includes('x'),
        typescript: extension?.startsWith('t'),
      })
    case 'json':
      return json()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'xml':
      return StreamLanguage.define(xml)
    case 'markdown':
      return markdown()
    case 'python':
      return python()
    case 'rust':
      return rust()
    case 'yaml':
      return StreamLanguage.define(yaml)
    case 'sql':
      return StreamLanguage.define(standardSQL)
    case 'c':
      return StreamLanguage.define(c)
    case 'cpp':
      return StreamLanguage.define(cpp)
    case 'go':
      return StreamLanguage.define(go)
    case 'java':
      return StreamLanguage.define(java)
    default:
      return []
  }
}

export const WORKSPACE_EDITOR_THEME = {
  '&': {
    height: '100%',
    fontSize: 'var(--text-code)',
    backgroundColor: 'rgb(var(--color-bg-base))',
    color: 'rgb(var(--color-text-primary))',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-code)',
  },
  '.cm-content, .cm-line': { caretColor: 'rgb(var(--color-text-primary))' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--color-text-primary))' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgb(var(--color-primary) / 0.18)',
  },
  '.cm-gutters': {
    backgroundColor: 'rgb(var(--color-bg-surface))',
    borderRight: '1px solid rgb(var(--color-border))',
    color: 'rgb(var(--color-text-muted))',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'rgb(var(--color-bg-surface))',
  },
  '.cm-searchMatch': { backgroundColor: 'rgb(var(--color-primary) / 0.16)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgb(var(--color-primary) / 0.28)',
  },
  '&.cm-focused': { outline: 'none' },
}

export const WORKSPACE_EDITOR_HIGHLIGHT_STYLE = HighlightStyle.define([
  { tag: tags.comment, color: 'rgb(var(--color-text-muted))', fontStyle: 'italic' },
  {
    tag: [tags.keyword, tags.modifier, tags.typeName],
    color: 'rgb(var(--color-text-primary))',
    fontWeight: '500',
  },
  {
    tag: [tags.name, tags.propertyName, tags.variableName],
    color: 'rgb(var(--color-text-primary))',
  },
  {
    tag: [tags.string, tags.regexp, tags.number, tags.bool],
    color: 'rgb(var(--color-text-secondary))',
  },
  {
    tag: [tags.heading, tags.link],
    color: 'rgb(var(--color-text-primary))',
    fontWeight: '500',
  },
  { tag: tags.invalid, color: 'rgb(220 38 38)' },
])
