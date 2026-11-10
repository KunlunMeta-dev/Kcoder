import type { ChatMessage, TaskActivityView } from '@/runtime/task-runtime/types';

export interface ProviderRetryProgress { attempt: number; maxRetries: number }
export function providerRetryProgress(activity: TaskActivityView): ProviderRetryProgress | undefined {
  const progress = activity.providerRetry;
  if (progress && Number.isSafeInteger(progress.attempt) && progress.attempt >= 1 && Number.isSafeInteger(progress.maxRetries) && progress.maxRetries >= progress.attempt) return progress;
  // Older histories contain the backend's formatted notice without structured metadata.
  if (activity.type !== 'notice') return undefined;
  const match = /^Provider\s+main\s+request failed\b[\s\S]*;\s*retrying\s+(\d+)\/(\d+)\s+after\s+\d+ms(?:\.{3}|…)?$/i.exec(activity.label);
  if (!match) return undefined;
  const attempt = Number(match[1]), maxRetries = Number(match[2]);
  return Number.isSafeInteger(attempt) && attempt >= 1 && Number.isSafeInteger(maxRetries) && maxRetries >= attempt ? { attempt, maxRetries } : undefined;
}
export function messageProviderRetries(message: Pick<ChatMessage, 'orderedBlocks' | 'activities'>): TaskActivityView[] {
  const activities = message.orderedBlocks !== undefined
    ? message.orderedBlocks.flatMap(block => block.kind === 'activity' ? [block.activity] : [])
    : message.activities ?? [];
  return activities.filter(activity => providerRetryProgress(activity));
}
export function providerRetryCount(activities: readonly TaskActivityView[]): number {
  let count = 0, previousAttempt = 0;
  for (const activity of activities) {
    const progress = providerRetryProgress(activity);
    if (!progress) continue;
    count += progress.attempt > previousAttempt ? progress.attempt - previousAttempt : progress.attempt;
    previousAttempt = progress.attempt;
  }
  return count;
}
