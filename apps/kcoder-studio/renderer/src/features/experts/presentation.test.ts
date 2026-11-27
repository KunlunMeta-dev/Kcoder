import { expect, it } from 'vitest'
import { newExpert } from './client'
import {
  annotations,
  expertPresentation,
  expertAvatar,
  updateAnnotations,
  withPresentation,
} from './presentation'

it('retains editor preferences and original task input fields when changing card presentation', () => {
  const definition = {
    ...newExpert('en'),
    inputSchema: { type: 'object', properties: { material: { type: 'string' } } },
  }
  const configured = updateAnnotations(definition, {
    welcome: 'Review the source',
    mode: 'plan',
    skills: ['qa'],
    trajectory: false,
  })
  const changed = withPresentation(configured, { color: '#2563eb', enabled: false })
  expect(annotations(changed)).toMatchObject({
    welcome: 'Review the source',
    mode: 'plan',
    skills: ['qa'],
    trajectory: false,
    color: '#2563eb',
    enabled: false,
  })
  expect(changed.inputSchema).toHaveProperty('properties.material.type', 'string')
  expect(changed.allowedTools).toBeNull()
  expect(changed.externalSend).toBe('deny')
  expect(annotations(configured)).not.toHaveProperty('enabled')
})
it('does not interpret malformed presentation or CSS as executable authority', () => {
  const definition = {
    ...newExpert('en'),
    inputSchema: {
      type: 'object',
      'x-kcoder-expert': {
        color: 'url(https://example.test/track)',
        members: ['personal.one', 7],
        kind: 'system',
        enabled: true,
      },
    },
  }
  expect(expertPresentation(definition)).toEqual({
    color: '#6366f1',
    members: ['personal.one'],
    kind: 'expert',
    enabled: true,
  })
  expect(annotations({ ...definition, inputSchema: null })).toEqual({})
})
it('resolves only bundled avatars or bounded WebP thumbnails', () => {
  const definition = newExpert('en')
  expect(
    expertAvatar(updateAnnotations(definition, { avatarPreset: 'octop:general-assistant.svg' }))
  ).toMatch(/general-assistant/)
  expect(
    expertAvatar(updateAnnotations(definition, { avatarPreset: 'octop:../../settings.svg' }))
  ).toBeUndefined()
  expect(
    expertAvatar(updateAnnotations(definition, { avatar: 'https://example.test/track' }))
  ).toBeUndefined()
  expect(
    expertAvatar(
      updateAnnotations(definition, { avatar: 'data:image/webp;base64,' + 'a'.repeat(8192) })
    )
  ).toBeUndefined()
})
