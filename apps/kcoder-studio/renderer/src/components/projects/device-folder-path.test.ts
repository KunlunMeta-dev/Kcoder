import { describe, expect, test } from 'vitest'
import { getParentPath, getPathSearchParts, joinPath, normalizePath } from './device-folder-path'

describe('target folder paths', () => {
  test('preserves Windows drive roots while browsing and joining', () => {
    expect(normalizePath('C:\\Users\\person\\')).toBe('C:/Users/person')
    expect(getParentPath('C:/Users')).toBe('C:/')
    expect(getParentPath('C:/')).toBe('C:/')
    expect(joinPath('C:/', 'Users')).toBe('C:/Users')
    expect(getPathSearchParts('C:\\Users\\')).toEqual({ parentPath: 'C:/Users', query: '' })
  })
  test('keeps a UNC share as the navigation root', () => {
    expect(normalizePath(String.raw`\\server\share\plugins`)).toBe('//server/share/plugins')
    expect(getParentPath('//server/share/plugins')).toBe('//server/share')
    expect(getParentPath('//server/share')).toBe('//server/share')
    expect(joinPath('//server/share', 'plugins')).toBe('//server/share/plugins')
    expect(getPathSearchParts('//server/share')).toEqual({
      parentPath: '//server/share',
      query: '',
    })
  })
  test('preserves POSIX roots and literal backslashes', () => {
    expect(getParentPath('/plugins')).toBe('/')
    expect(joinPath('/', 'plugins')).toBe('/plugins')
    expect(getPathSearchParts('/home/')).toEqual({ parentPath: '/home', query: '' })
    expect(normalizePath(String.raw`/home/with\slash`)).toBe(String.raw`/home/with\slash`)
  })
})
