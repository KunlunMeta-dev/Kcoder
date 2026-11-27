import { expect, it } from 'vitest'
import { packageSkills, skillSnapshot } from './skillPresentation'

it('imports reviewed instructions disabled and handles missing or quoted frontmatter', () => {
  expect(skillSnapshot('notes', 'Summarize the meeting')).toEqual({
    slug: 'notes',
    title: 'notes',
    description: '',
    content: 'Summarize the meeting',
    enabled: false,
  })
  expect(
    skillSnapshot(
      'notes',
      '---\nname: "Meeting notes"\ndescription: Keep sources\n---\n\nUse cited facts.'
    )
  ).toEqual({
    slug: 'notes',
    title: 'Meeting notes',
    description: 'Keep sources',
    content: '---\nname: "Meeting notes"\ndescription: Keep sources\n---\n\nUse cited facts.',
    enabled: false,
  })
  expect(packageSkills(null)).toEqual([])
})
