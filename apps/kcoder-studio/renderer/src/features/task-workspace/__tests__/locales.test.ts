import { describe, expect, test } from 'vitest'
import { taskWorkspaceResources } from '../locales'
import { workControlStateLabels, workInputStateLabels } from '../taskBoardModel'

const locales = [taskWorkspaceResources.en, taskWorkspaceResources['zh-CN']]

describe('task workspace appended input and control copy', () => {
  test('every projection label has en and zh-CN copy', () => {
    for (const resources of locales) {
      expect(Object.keys(resources.board.workInput)).toEqual(
        expect.arrayContaining(['label', ...workInputStateLabels])
      )
      expect(Object.keys(resources.board.workControl)).toEqual(
        expect.arrayContaining(['label', ...workControlStateLabels])
      )
    }
    expect(Object.keys(taskWorkspaceResources.en.board.workInput)).toEqual(
      Object.keys(taskWorkspaceResources['zh-CN'].board.workInput)
    )
    expect(Object.keys(taskWorkspaceResources.en.board.workControl)).toEqual(
      Object.keys(taskWorkspaceResources['zh-CN'].board.workControl)
    )
  })
  test('copy keeps a page-local queue and a pending control apart from success', () => {
    const en = taskWorkspaceResources.en.board
    expect(en.workInput.queuedInPageOnly).toMatch(/page only/i)
    expect(en.workInput.queuedInPageOnly).not.toMatch(/accepted/i)
    expect(en.workInput.applied).not.toMatch(/complet/i)
    expect(en.workControl.submitted).toMatch(/waiting for settlement/i)
    expect(en.workControl.superseded).toMatch(/newer control/i)
    expect(en.workControl.needsReview).toMatch(/needs review/i)
    const zh = taskWorkspaceResources['zh-CN'].board
    expect(zh.workInput.queuedInPageOnly).toContain('仅本次页面内排队')
    expect(zh.workControl.submitted).toContain('等待结算')
    expect(zh.workControl.failed).toContain('失败')
  })
})