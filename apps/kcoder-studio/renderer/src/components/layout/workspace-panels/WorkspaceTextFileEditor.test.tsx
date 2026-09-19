import { describe, expect, test } from 'vitest'
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
