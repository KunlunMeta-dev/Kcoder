import { expect, test } from 'vitest'
import { relativeWorkspaceFilePath } from './workspace-file-path'

const windowsRoot = 'C:/Users/kunlunmeta/proj'

test('relative paths use the normalized workspace root', () => {
  expect(relativeWorkspaceFilePath(windowsRoot, `${windowsRoot}/src/a.ts`)).toBe('src/a.ts')
  expect(relativeWorkspaceFilePath(windowsRoot, windowsRoot)).toBe('')
  expect(relativeWorkspaceFilePath(windowsRoot, 'C:/Users/kunlunmeta/other/a.ts')).toBe('')
})

test('windows drive casing does not break the relative path', () => {
  expect(relativeWorkspaceFilePath(windowsRoot, 'c:/users/KunlunMeta/proj/src/a.ts')).toBe(
    'src/a.ts'
  )
})

test('namespaced roots and drive roots resolve without a leading separator', () => {
  expect(
    relativeWorkspaceFilePath(String.raw`\\?\C:\Users\kunlunmeta\proj`, `${windowsRoot}/src/a.ts`)
  ).toBe('src/a.ts')
  expect(relativeWorkspaceFilePath('C:/', 'C:/src/a.ts')).toBe('src/a.ts')
})

test('paths outside the workspace root have no relative form', () => {
  expect(relativeWorkspaceFilePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
  expect(relativeWorkspaceFilePath('/repo', String.raw`\\?\C:\other\a.ts`)).toBe('')
  expect(relativeWorkspaceFilePath('', '/repo/src/a.ts')).toBe('')
})
