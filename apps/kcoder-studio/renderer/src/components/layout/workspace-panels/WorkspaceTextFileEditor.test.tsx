import { describe, expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { workspaceFileLineSeparator } from './workspaceTextFileEditorConfig'
import { WORKSPACE_EDITOR_THEME, languageNameForPath } from './workspaceTextFileEditorConfig'

describe('WorkspaceTextFileEditor', () => {
  test.each([
    ['config.yaml', 'yaml'],
    ['query.sql', 'sql'],
    ['pom.xml', 'xml'],
    ['main.c', 'c'],
    ['main.cc', 'cpp'],
    ['main.cpp', 'cpp'],
    ['main.h', 'cpp'],
    ['main.go', 'go'],
    ['Main.java', 'java'],
  ])('selects %s syntax support', (path, expectedLanguage) => {
    expect(languageNameForPath(path)).toBe(expectedLanguage)
  })

  test('uses application appearance variables instead of fixed light colors', () => {
    expect(WORKSPACE_EDITOR_THEME['&']).toMatchObject({
      backgroundColor: 'rgb(var(--color-bg-base))',
      color: 'rgb(var(--color-text-primary))',
    })
    expect(WORKSPACE_EDITOR_THEME['.cm-gutters']).toMatchObject({
      backgroundColor: 'rgb(var(--color-bg-surface))',
      borderRight: '1px solid rgb(var(--color-border))',
      color: 'rgb(var(--color-text-muted))',
    })
    expect(JSON.stringify(WORKSPACE_EDITOR_THEME)).not.toContain('255 255 255')
  })
})

test.each(['\r\n', '\n', '\r'])(
  'retains BOM, Unicode and trailing empty lines with %j separators after editing',
  separator => {
    const original = '\uFEFF中文' + separator + 'last' + separator + separator
    const state = EditorState.create({
      doc: original,
      extensions: [EditorState.lineSeparator.of(workspaceFileLineSeparator(original))],
    })
    const changed = state.update({
      changes: { from: state.doc.length, insert: separator + 'edited' },
    }).state
    expect(changed.sliceDoc()).toBe(original + separator + 'edited')
  }
)
