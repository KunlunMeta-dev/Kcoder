import { useState } from 'react'
import { RetainedPage } from '../../src/components/layout/retainedPages'
import { ThinkingElapsedTime } from '../../src/components/chat/ThinkingElapsedTime'
import { ToolBlockItem } from '../../src/components/chat/blocks/ToolBlockItem'
import { ToolBlocksDisplay } from '../../src/components/chat/blocks/ToolBlocksDisplay'
import { GoalStatusBar } from '../../src/components/chat/composer/GoalStatusBar'
import { ProviderRetryStatus } from '../../src/components/chat/ProviderRetryStatus'
import { WikiJobStatus } from '../../src/features/knowledge/WikiJobStatus'
import { formatRelativeSidebarTime, useSidebarRelativeTimeRefresh } from '../../src/components/layout/runtimeSidebarTime'

function SidebarClock({ open, startedAt }: { open: boolean; startedAt: number }) {
  useSidebarRelativeTimeRefresh(open)
  return <output data-testid="fixture-sidebar-time" hidden={!open}>
    {formatRelativeSidebarTime(startedAt - 60_000)}
  </output>
}

/** Synthetic presentation only: no tool or model is executed. */
export function DetailClocksFixture() {
  const [active, setActive] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [startedAt] = useState(Date.now)
  const [completedAt, setCompletedAt] = useState<number>()
  const running = completedAt === undefined
  return <div className="min-h-dvh space-y-4 bg-background p-4 text-text-primary">
    <div className="flex gap-4">
      <button data-testid="fixture-clock-toggle" aria-pressed={active} onClick={() => setActive(value => !value)}>Toggle page</button>
      <button data-testid="fixture-clock-finish" disabled={!running} onClick={() => setCompletedAt(Date.now())}>Finish</button>
      <button data-testid="fixture-sidebar-toggle" onClick={() => setSidebarOpen(value => !value)}>Toggle sidebar</button>
    </div>
    <RetainedPage open={active}>
      <section data-testid="fixture-detail-clocks" className="space-y-4">
        <SidebarClock open={sidebarOpen} startedAt={startedAt} />
        <WikiJobStatus job={{ id: 'fixture-job', sourceId: 'fixture-source', afterChunk: 0,
          status: running ? 'running' : 'completed', progress: { phase: 'generation',
            startedAtMs: startedAt, phaseStartedAtMs: startedAt, heartbeatAtMs: startedAt,
            model: 'fixture/model', textBytes: 0, reasoningBytes: 0, reservedCalls: 0,
            repairCalls: 0, usageReportedCalls: 0 } }} disconnected={false} />
        <GoalStatusBar goal={{ threadId: 'fixture-goal', objective: 'Local Goal clock', mode: 'standard',
          status: running ? 'active' : 'complete', tokensUsed: 0, tokenBudget: null,
          timeUsedSeconds: completedAt === undefined ? 0 : Math.floor((completedAt - startedAt) / 1000),
          createdAt: startedAt, updatedAt: completedAt ?? startedAt, events: [] }} />
        <ThinkingElapsedTime startedAt={startedAt} completedAt={completedAt} running={running} />
        {running && <ProviderRetryStatus activity={{ attempt: 1, maxRetries: 3,
          retryAfterMs: 15_000, receivedAtMs: startedAt }} />}
        <ToolBlockItem block={{ id: 'fixture-timed-tool', type: 'tool', toolName: 'Read',
          toolInput: { filePath: '/fixture/note.txt' }, status: running ? 'streaming' : 'done',
          createdAt: startedAt, completedAt }} />
        <ToolBlocksDisplay blocks={[{ id: 'fixture-timed-summary', type: 'tool', toolName: 'Read',
          toolInput: { filePath: '/fixture/note.txt' }, status: running ? 'streaming' : 'done',
          createdAt: startedAt, completedAt }]} isStreaming={running} startedAt={startedAt} />
      </section>
    </RetainedPage>
  </div>
}
