import { TaskObservationOverview } from '../../src/features/task-workspace/TaskObservationOverview'
import type { TaskWorkspaceSnapshot } from '../../../shared/generated/contracts'
import { Button } from '../../src/components/ui/button'
const snapshot: TaskWorkspaceSnapshot = {
  schemaVersion: 1, snapshotId: 'layout-only', observedAtMs: 1793318400000,
  scope: { accountId: 'preview', targetId: 'local', workspaceId: '/preview', identityGeneration: '1', targetRevision: '1' },
  thread: { reference: { kind: 'thread', threadId: 'preview' }, title: '用户的喜好', nativeStatus: 'idle', sourceMethod: 'thread/read', nativeRevision: null },
  facets: [
    { kind: 'thread', observedCount: 1, availability: 'partial', reasonCode: null },
    { kind: 'goal', observedCount: 0, availability: 'available', reasonCode: null },
    { kind: 'agents', observedCount: null, availability: 'unknown', reasonCode: null },
    { kind: 'workflows', observedCount: 0, availability: 'available', reasonCode: null },
    { kind: 'runtime', observedCount: null, availability: 'unknown', reasonCode: null },
    { kind: 'sources', observedCount: null, availability: 'unknown', reasonCode: null },
    { kind: 'artifacts', observedCount: null, availability: 'unavailable', reasonCode: null },
  ], entries: [], artifactRefs: [], runtime: null, sourceSelection: null, nextCursor: null,
}
export function TaskOverviewStylePreview() {
  return <div className="mx-auto w-full max-w-[62.4rem] px-5 py-8"><TaskObservationOverview snapshot={snapshot} statusLabel="空闲" actions={<Button variant="outline">打开原页面</Button>} /></div>
}
