import { describe, expect, it } from 'vitest'
import {
  wikiFileAccept,
  wikiFileCapabilities,
  wikiFileIssue,
  wikiBatchIssue,
} from './wikiFileCapabilities'

describe('Wiki file rules shared by upload, replacement, directory and batch', () => {
  it('checks byte boundaries and case-insensitive Unicode filenames for every format', () => {
    for (const capability of wikiFileCapabilities) {
      for (const extension of capability.extensions) {
        const file = { name: `中文文件.${extension.toUpperCase()}`, size: capability.maxFileBytes }
        expect(wikiFileIssue(file)).toBeUndefined()
        expect(wikiFileIssue({ ...file, size: file.size + 1 })).toBe(
          capability.requiresVision ? 'imageLimit' : 'textLimit'
        )
        expect(wikiFileAccept()).toContain(`.${extension}`)
      }
    }
    for (const extension of ['doc', 'xls', 'ppt', 'exe'])
      expect(wikiFileIssue({ name: `file.${extension}`, size: 1 })).toBe('errorFormat')
  })
  it('keeps individual and aggregate limits distinct and respects target capability changes', () => {
    expect(wikiFileIssue({ name: 'picture.png', size: 11 * 1024 * 1024 })).toBe('imageLimit')
    expect(wikiBatchIssue(Array.from({ length: 11 }, () => ({ name: 'a.md', size: 1 })))).toBe(
      'batchLimit'
    )
    expect(
      wikiBatchIssue(Array.from({ length: 4 }, () => ({ name: 'a.md', size: 32 * 1024 * 1024 })))
    ).toBeUndefined()
    expect(
      wikiBatchIssue(Array.from({ length: 5 }, () => ({ name: 'a.md', size: 32 * 1024 * 1024 })))
    ).toBe('batchLimit')
    expect(
      wikiFileIssue(
        { name: 'a.pdf', size: 1 },
        wikiFileCapabilities.filter(item => item.format !== 'pdf')
      )
    ).toBe('errorFormat')
  })
})

it('honors known runtime absence without treating legacy/limited probes as unavailable', () => {
  const pdf = wikiFileCapabilities.find(item => item.format === 'pdf')!
  expect(
    wikiFileIssue({ name: 'paper.pdf', size: 1 }, [
      { ...pdf, available: false, unavailableReason: 'pdf_runtime_missing' },
    ])
  ).toBe('pdfRuntimeUnavailable')
  expect(wikiFileIssue({ name: 'paper.pdf', size: 1 }, [pdf])).toBeUndefined()
  expect(
    wikiFileIssue({ name: 'paper.pdf', size: 1 }, [
      { ...pdf, unavailableReason: 'pdf_runtime_probe_limited' },
    ])
  ).toBeUndefined()
})
