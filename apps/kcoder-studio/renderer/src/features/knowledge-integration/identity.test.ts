import { expect, it } from 'vitest'
import { sameKnowledgeOwner } from './identity'
it('compares normalized owner fields without JSON property order or null/omitted ambiguity', () => {
  const left = { accountId: 'a', targetId: 't', workspaceId: null }
  const right = { workspaceId: null, targetId: 't', organizationId: null, accountId: 'a' }
  expect(sameKnowledgeOwner(left, right)).toBe(true)
  expect(sameKnowledgeOwner(left, { ...right, targetId: 'other' })).toBe(false)
})
