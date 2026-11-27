import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestTransport } from '@/test/runtime-transport'
import {
  DEFAULT_TODO_WORKFLOW,
  hydrateLocalWorkItems,
  loadLocalWorkItems,
  loadTodoWorkflow,
  saveLocalWorkItems,
  saveTodoWorkflow,
} from './todoModel'

describe('todoModel', () => {
  beforeEach(() => window.localStorage.clear())

  it('migrates legacy drafts to root work items once', () => {
    window.localStorage.setItem(
      'wework:todo:drafts:1',
      JSON.stringify([
        {
          id: 'draft-1',
          projectId: 7,
          state: 'backlog',
          title: 'Legacy item',
          markdown: 'Legacy context',
          goal: 'Ship safely',
          priority: 'high',
          assignee: 'ai',
          attachments: [],
          createdAt: '2026-07-16T00:00:00Z',
          updatedAt: '2026-07-16T00:00:00Z',
        },
      ])
    )

    expect(loadLocalWorkItems(1)).toEqual([
      expect.objectContaining({
        id: 'draft-1',
        description: 'Legacy context',
        objective: 'Ship safely',
        assignee: { type: 'ai' },
      }),
    ])
    expect(window.localStorage.getItem('wework:todo:drafts:1')).toContain('Legacy item')
    const key = 'kcoder:todo:work-items:1'
    const migrated = window.localStorage.getItem(key)
    expect(migrated).toContain('Legacy item')
    // Simulate a profile that has already passed through the old draft migration.
    window.localStorage.setItem('wework:todo:work-items:1', migrated!)
    window.localStorage.removeItem(key)
    expect(loadLocalWorkItems(1)).toEqual([expect.objectContaining({ id: 'draft-1' })])
    expect(loadLocalWorkItems(2)).toEqual([])
    saveLocalWorkItems(1, [])
    expect(window.localStorage.getItem(key)).toBe('[]')
    expect(loadLocalWorkItems(1)).toEqual([])
  })

  it('stores workflow configuration per project', () => {
    const config = {
      ...DEFAULT_TODO_WORKFLOW,
      workTypes: [
        ...DEFAULT_TODO_WORKFLOW.workTypes,
        {
          key: 'security',
          name: 'Security',
          dependsOn: [],
          defaultAssignee: { type: 'human' as const, name: 'Security owner' },
        },
      ],
    }
    window.localStorage.setItem('wework:todo:workflow:7', JSON.stringify(config))
    expect(loadTodoWorkflow(7)).toEqual(config)
    expect(loadTodoWorkflow(9)).toEqual(DEFAULT_TODO_WORKFLOW)
    saveTodoWorkflow(7, DEFAULT_TODO_WORKFLOW)
    expect(window.localStorage.getItem('kcoder:todo:workflow:7')).not.toBeNull()
    expect(loadTodoWorkflow(7)).toEqual(DEFAULT_TODO_WORKFLOW)
  })

  it('prefers an empty Gateway result over an older local work list', async () => {
    const legacyKey = 'wework:todo:work-items:1'
    const legacyItems = JSON.stringify([{ id: 'old-item', title: 'Old item', projectId: 7 }])
    window.localStorage.setItem(legacyKey, legacyItems)
    expect(loadLocalWorkItems(1)).toHaveLength(1)
    const request = vi.fn().mockResolvedValue('[]')
    installTestTransport(request)

    expect(await hydrateLocalWorkItems(1)).toEqual([])
    expect(request).toHaveBeenCalledWith('load_todo_store', { scope: '1' })
    expect(window.localStorage.getItem('kcoder:todo:work-items:1')).toBe('[]')
    expect(window.localStorage.getItem(legacyKey)).toBe(legacyItems)
    expect(loadLocalWorkItems(1)).toEqual([])
  })
})
