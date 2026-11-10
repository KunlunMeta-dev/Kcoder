import { expect, test } from 'vitest'
import { parseUnifiedDiff } from './parseUnifiedDiff'

test('decodes Git octal UTF-8 paths and literal quotes without changing patch bytes', () => {
  const diff = 'diff --git "a/\\350\\265\\204\\346\\226\\231.txt" "b/\\350\\265\\204\\346\\226\\231.txt"\n@@ -1 +1 @@\n-old\n+new'
  const result = parseUnifiedDiff(diff)
  expect(result[0].path).toBe('资料.txt')
  expect(result[0].oldPath).toBe('资料.txt')
  expect(result[0].lines.join('\n')).toBe(diff)
  expect(parseUnifiedDiff('diff --git "a/report \\"draft\\".txt" "b/report \\"draft\\".txt"')[0].path).toBe('report "draft".txt')
})

test('handles unquoted spaces, rename metadata and repeated sections', () => {
  expect(parseUnifiedDiff('diff --git a/folder b/file.txt b/folder b/file.txt')[0].path).toBe('folder b/file.txt')
  const sections = parseUnifiedDiff('diff --git a/old b/name.txt b/new b/name.txt\nrename from old b/name.txt\nrename to new b/name.txt\ndiff --git a/new b/name.txt b/new b/name.txt\n@@ -1 +1 @@\n-before\n+after')
  expect(sections).toHaveLength(1)
  expect(sections[0].oldPath).toBe('old b/name.txt')
  expect(sections[0].path).toBe('new b/name.txt')
  expect(sections[0].lines).toContain('+after')
})

test('hunk content cannot retarget a file and malformed quoted bytes are not decoded as a path', () => {
  expect(parseUnifiedDiff('diff --git a/real.txt b/real.txt\n@@ -1 +1 @@\nrename to fake.txt')[0].path).toBe('real.txt')
  expect(parseUnifiedDiff('diff --git "a/\\377" "b/\\377"')).toEqual([])
})
