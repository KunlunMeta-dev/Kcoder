import { describe, expect, test } from 'vitest'
import { sameWorkspacePath, workspacePathKey } from './workspace-path-identity'

describe('target workspace identity', () => {
  test.each([
    [String.raw`\\?\D:\ComfyUI-master`, String.raw`D:\ComfyUI-master`],
    [String.raw`\\?\D:\ComfyUI-master`, 'd:/ComfyUI-master/'],
    ['D:\\', 'd:/'],
    [String.raw`\\?\UNC\server\share\project`, String.raw`\\server\share\project` + '\\'],
    [String.raw`\\server\share\project`, '//server/share/project'],
    ['/srv/project/', '/srv/project'],
  ])('matches equivalent paths %s and %s', (left, right) => {
    expect(sameWorkspacePath(left, right)).toBe(true)
    expect(workspacePathKey(workspacePathKey(left))).toBe(workspacePathKey(left))
  })
  test.each([
    ['/srv/Project', '/srv/project'],
    ['D:/Project', 'D:/project'],
    [String.raw`/srv/a\b`, '/srv/a/b'],
    ['D:project', 'D:/project'],
    [String.raw`\\.\D:\project`, 'D:/project'],
    [String.raw`\\?\Volume{abc}\project`, '/Volume{abc}/project'],
    ['//server/share/project', '/server/share/project'],
    ['/srv/link/../project', '/srv/project'],
    ['D:/a', 'E:/a'],
    [String.raw`\\?\D:\project.`, String.raw`D:\project.`],
    [String.raw`\\?\D:\project `, String.raw`D:\project`],
    [String.raw`\\?\D:\link\..\project`, String.raw`D:\link\..\project`],
    ['/srv/project ', '/srv/project'],
  ])('keeps distinct paths %s and %s separate', (left, right) => {
    expect(sameWorkspacePath(left, right)).toBe(false)
  })
})
