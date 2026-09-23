import i18n from '@/i18n'
import type { ProcessingBlock } from '@/types/workbench'

export function getDurationText(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): string {
  const durationMs = getProcessingDurationMs(blocks, turnStartedAt, now, completedAt, isRunning)
  if (durationMs < 1000) return ''
  return i18n.t('toolStatus.processedDuration', {
    ns: 'chat',
    duration: formatDuration(durationMs),
  })
}

export function getWholeSecondsDurationText(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): string {
  const durationMs = getProcessingDurationMs(blocks, turnStartedAt, now, completedAt, isRunning)
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return i18n.t('toolStatus.seconds', { ns: 'chat', count: seconds })

  const minutes = Math.floor(seconds / 60)
  return i18n.t('toolStatus.minutesSeconds', { ns: 'chat', minutes, seconds: seconds % 60 })
}

function getProcessingDurationMs(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): number {
  const lastBlock = blocks[blocks.length - 1]
  const last = lastBlock?.completedAt ?? lastBlock?.createdAt ?? turnStartedAt
  const endTime = isRunning ? now : (completedAt ?? last)
  return Math.max(isRunning ? 1000 : 0, endTime - turnStartedAt)
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return i18n.t('toolStatus.seconds', { ns: 'chat', count: seconds })

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0
      ? i18n.t('toolStatus.minutesSeconds', { ns: 'chat', minutes, seconds: remainingSeconds })
      : i18n.t('toolStatus.minutes', { ns: 'chat', count: minutes })
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0
    ? i18n.t('toolStatus.hours', { ns: 'chat', count: hours })
    : i18n.t('toolStatus.hoursMinutes', { ns: 'chat', hours, minutes: remainingMinutes })
}
