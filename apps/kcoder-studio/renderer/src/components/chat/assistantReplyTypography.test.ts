import { expect, test } from 'vitest'
import { resolveAssistantReplyTypography } from './assistantReplyTypography'

test('preserves the three old line heights and adds two distinct reading choices', () => {
  expect(['compact', 'snug', 'normal', 'relaxed', 'airy'].map(value => resolveAssistantReplyTypography('normal', value as 'normal').body.lineHeight)).toEqual(['20px', '22px', '24px', '30px', '34px'])
})

test('new spacing and font apply only when conversation reading is requested', () => {
  const defaultStyle = resolveAssistantReplyTypography('normal', 'normal').body
  expect(defaultStyle).not.toHaveProperty('fontFamily')
  expect(defaultStyle).not.toHaveProperty('letterSpacing')
  const reading = resolveAssistantReplyTypography('normal', 'normal', { blockSpacing: 'relaxed', letterSpacing: 'compact', fontFamily: 'Noto Sans SC' }).body
  expect(reading).toMatchObject({ '--conversation-block-gap': '18px', letterSpacing: '0px', fontFamily: 'Noto Sans SC' })
})

test('conversation headings use distinct semantic roles while honoring font and line preferences', () => {
  const reading = resolveAssistantReplyTypography('large','relaxed',{blockSpacing:'normal',letterSpacing:'normal'})
  expect(reading.heading1).toMatchObject({fontSize:'calc(var(--text-heading-md) * 1.15)',lineHeight:'36px'})
  expect(reading.heading2).toMatchObject({fontSize:'calc(var(--text-heading-sm) * 1.15)',lineHeight:'34px'})
  expect(reading.heading3).toMatchObject({fontSize:'calc(var(--text-lg) * 1.15)',lineHeight:'30px'})
  const ordinary = resolveAssistantReplyTypography('normal','normal').heading1
  expect(ordinary.fontSize).toBe('18px')
  expect(ordinary.lineHeight).toBe('28px')
})
