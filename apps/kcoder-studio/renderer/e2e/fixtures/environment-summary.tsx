import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EnvironmentInfoPopover } from '../../src/components/layout/EnvironmentInfoPopover'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import type { EnvironmentInfo } from '../../src/types/environment'
import { SubagentStatusIndicator } from '../../src/components/layout/SubagentStatusIndicator'

// Rendering only: no backend, Git repository, credentials or model calls.
const query = new URLSearchParams(location.search)
await i18n.changeLanguage(query.get('locale') ?? 'zh-CN')
document.documentElement.setAttribute('data-theme', query.get('theme') ?? 'light')
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark')
const legacy = query.get('state') === 'legacy'
const plain = query.get('state') === 'plain'
const docked = query.has('docked')
const info: EnvironmentInfo = {
  executionTarget: 'local',
  workspacePath: docked ? String.raw`Z:\Google_Download\gptf-platform-main\gptf-platform-main` : '/workspace/feature',
  isGitRepository: !plain,
  branchName: plain ? undefined : 'feature/accurate-change-counts',
  additions: plain ? '' : '+3,438',
  deletions: plain ? '' : '-220',
  ...(!legacy && !plain
    ? {
        changeSummary: {
          kind: 'merge-base' as const,
          reference: 'origin/main',
          commit: 'a'.repeat(40),
          fileCount: 12,
          binaryFiles: 1,
        },
      }
    : {}),
}

export function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(true)
  const [reviewRequested, setReviewRequested] = useState(false)
  return (
    <main className="min-h-dvh bg-background p-4 text-text-primary">
      <EnvironmentInfoPopover
        info={info}
        popoverContainer={container}
        open={open}
        docked={docked}
        onOpenChange={setOpen}
        onOpenChangesReview={() => setReviewRequested(true)}
      />
      <section className={docked ? 'fixed left-4 flex flex-col items-start' : undefined}
        style={docked ? (query.get('edge') === 'top' ? { top: 40 } : { bottom: 56 }) : undefined}>
        <div ref={setContainer} />
        {docked && <SubagentStatusIndicator className="z-popover mt-3" statuses={Array.from({ length: 4 }, (_, index) => ({
          id: `fixture-${index}`, agentId: `fixture-${index}`, agentPath: `root/${index}`,
          status: 'done', agentName: `Agent ${index + 1}`,
        }))} />}
      </section>
      {reviewRequested && <p data-testid="review-requested">Review requested</p>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
