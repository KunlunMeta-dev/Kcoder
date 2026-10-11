import { expect, test } from 'vitest'
import {
  normalizeAbsoluteWorkspacePath as normalize,
  resolveWorkspaceFilePath as resolve,
  splitAbsoluteWorkspaceFilePath as split,
} from '../workspace-file-path'

test.each([
  ['\\\\?\\D:\\slime', 'D:/slime'],
  ['d:\\slime\\文件.txt', 'D:/slime/文件.txt'],
  ['D:/slime/./src/../file.txt', 'D:/slime/file.txt'],
  ['\\\\server\\share\\folder', '//server/share/folder'],
  ['\\\\?\\UNC\\server\\share\\folder', '//server/share/folder'],
  ['/workspace//src/../file', '/workspace/file'],
  ['/workspace/a\\b', '/workspace/a\\b'],
])('accepts target path %s without host OS assumptions', (input, expected) => {
  expect(normalize(input, 'invalid')).toBe(expected)
})

test.each([
  'D:relative',
  'relative',
  '\\\\.\\PhysicalDrive0',
  '\\\\?\\GLOBALROOT\\Device',
  '\\\\server',
  '\\\\server\\share\\..\\escape',
  'D:/../../escape',
  '/../../escape',
  'D:/bad\u0000name',
  '\\\\?\\D:\\literal.',
  '\\\\?\\D:\\literal ',
  '\\\\?\\D:\\folder\\..\\file',
  '\\\\?\\D:\\folder/file',
])('rejects unsafe or incomplete root %s', input => {
  expect(() => normalize(input, 'invalid')).toThrow('invalid')
})

test('keeps drive roots absolute when splitting file paths', () => {
  expect(split('\\\\?\\D:\\file.txt')).toEqual({ parentPath: 'D:/', fileName: 'file.txt' })
  expect(split('\\\\server\\share\\file.txt')).toEqual({
    parentPath: '//server/share',
    fileName: 'file.txt',
  })
  expect(() => split('D:/')).toThrow()
  expect(() => split('\\\\server\\share')).toThrow()
})

test.each([
  [String.raw`//?/D:/slime`, 'D:/slime'],
  [String.raw`//?/D:/slime/src/file.txt`, 'D:/slime/src/file.txt'],
  [String.raw`//?/D:\slime`, 'D:/slime'],
  [String.raw`//?/UNC/server/share/folder`, '//server/share/folder'],
])('rewrites posix-spelled windows namespaces onto canonical paths %s', (input, expected) => {
  expect(normalize(input, 'invalid')).toBe(expected)
})

test.each([
  String.raw`//?/D:/literal.`,
  String.raw`//?/D:/literal `,
  String.raw`//?/relative/path`,
  String.raw`//?/`,
])('rejects unsafe posix-spelled namespaces %s', input => {
  expect(() => normalize(input, 'invalid')).toThrow('invalid')
})

test.each([
  [
    String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service`,
    'src/registry.rs',
    'C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs',
  ],
  [
    String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service`,
    String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service\src\registry.rs`,
    'C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs',
  ],
  [
    String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-model-service`,
    String.raw`//?/C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs`,
    'C:/Users/kunlunmeta/projects/gpt-model-service/src/registry.rs',
  ],
  ['/Users/dev/project', 'src/main.ts', '/Users/dev/project/src/main.ts'],
  [String.raw`C:\Users\dev\project`, String.raw`src\main.ts`, 'C:/Users/dev/project/src/main.ts'],
  ['/Users/dev/project', String.raw`C:\other\file.ts`, 'C:/other/file.ts'],
  ['/Users/dev/project', '/etc/hosts', '/etc/hosts'],
  ['C:/', 'src/x.ts', 'C:/src/x.ts'],
])('resolves file request %s + %s', (root, requested, expected) => {
  expect(resolve(root, requested)).toBe(expected)
})

test.each([
  ['/Users/dev/project', '../secrets'],
  ['/Users/dev/project', '..'],
  ['/Users/dev/project', ''],
  ['relative-root', 'src/x.ts'],
  ['/Users/dev/project', String.raw`\\?\D:\folder\..\file`],
  ['/Users/dev/project', String.raw`\\?\D:\project.`],
])('returns null for unresolvable file request %s + %s', (root, requested) => {
  expect(resolve(root, requested)).toBeNull()
})
