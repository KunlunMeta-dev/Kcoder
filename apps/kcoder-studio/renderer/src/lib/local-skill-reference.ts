import type { LocalDeviceSkill } from '@/types/api'

// Keep restored messages and composer chips aligned across target operating systems.
export const SKILL_MENTION_TARGET_PATTERN = String.raw`(?:skill:\/\/|\/|[a-zA-Z]:[\\/]|\\\\)(?:[^()\r\n]|\([^()\r\n]*\))*?SKILL\.md`

export function localSkillFilePath(target: string): string | null {
  let path = target
  if (target.startsWith('skill://')) {
    try { path = decodeURIComponent(target.slice('skill://'.length)) }
    catch { return null }
  }
  return /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path) && /[\\/]SKILL\.md$/.test(path) ? path : null
}

export function localSkillReference(
  skill: Pick<LocalDeviceSkill, 'name' | 'path'>,
  mentionName = skill.name
): string {
  const target = /[()]/.test(skill.path)
    ? `skill://${encodeURIComponent(skill.path).replace(/[()]/g, char => char === '(' ? '%28' : '%29')}`
    : skill.path
  return `[$${mentionName}](${target})`
}
