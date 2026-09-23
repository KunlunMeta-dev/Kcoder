import { describe, expect, it } from 'vitest'

import { settingsTemplateBadgeState } from '@/kcoder/settingsTemplateBadge'

const catalog = [
  { id: 'fast-local', name: 'Fast local', revisionSha256: 'rev-1' },
  { id: 'no-bash', name: 'No bash', revisionSha256: 'rev-2' },
]

describe('settings template badge', () => {
  it('hides the badge without a binding or catalog', () => {
    expect(settingsTemplateBadgeState(null, catalog)).toBeUndefined()
    expect(settingsTemplateBadgeState({ id: 'fast-local', revisionSha256: 'rev-1' }, null)).toBeUndefined()
  })

  it('shows the bound template name while the revision matches', () => {
    expect(
      settingsTemplateBadgeState({ id: 'fast-local', revisionSha256: 'rev-1' }, catalog)
    ).toEqual({ name: 'Fast local', status: 'current' })
  })

  it('marks a drifted binding when the template moved on', () => {
    expect(
      settingsTemplateBadgeState({ id: 'no-bash', revisionSha256: 'rev-1' }, catalog)
    ).toEqual({ name: 'No bash', status: 'drifted' })
  })

  it('marks a deleted template and keeps the recorded id', () => {
    expect(
      settingsTemplateBadgeState({ id: 'removed', revisionSha256: 'rev-9' }, catalog)
    ).toEqual({ name: 'removed', status: 'missing' })
  })
})
