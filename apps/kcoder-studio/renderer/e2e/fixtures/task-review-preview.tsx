import { reviewEvidenceFixture } from '../../src/features/workbench/reviewEvidence.test-support'
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageList } from '../../src/components/chat/MessageList'
import {
  BufferedChatInput,
  type BufferedChatInputInsertion,
} from '../../src/components/layout/BufferedChatInput'
import { Button } from '../../src/components/ui/button'
import type { WorkbenchMessage } from '../../src/types/workbench'
import type { TurnFileChangesCapture } from '../../../shared/generated/contracts'
import { applyAppearance } from '../../src/features/appearance/applyAppearance'
import { defaultAppearance } from '../../src/features/appearance/presets'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

// Synthetic conversation evidence; this fixture makes no Native or model calls.
await i18n.changeLanguage('zh-CN')
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
const captureMode = new URLSearchParams(location.search).get('capture')
applyAppearance(defaultAppearance, theme)

export function Preview() {
  const [scope, setScope] = useState('thread-A')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [insertion, setInsertion] = useState<BufferedChatInputInsertion | null>(null)
  const [sent, setSent] = useState(0)
  const [openedFile, setOpenedFile] = useState('')
  const changeDraft = useCallback(
    (value: string) => setDrafts(current => ({ ...current, [scope]: value })),
    [scope]
  )
  const capture: TurnFileChangesCapture | undefined =
    captureMode === 'legacy'
      ? undefined
      : {
          version: 1,
          captureId: 'a'.repeat(64),
          threadId: scope,
          turnId: `turn-${scope}`,
          attemptId: `turn-${scope}`,
          state: captureMode === 'partial' ? 'partial' : 'failed',
          limitations: captureMode === 'partial' ? ['policyExclusions'] : ['captureFailed'],
          base: { startedAtMs: 1792972800000, completedAtMs: 1792972801000 },
          head:
            captureMode === 'partial'
              ? { startedAtMs: 1792972802000, completedAtMs: 1792972803000 }
              : null,
          artifactId: null,
        }
  const message: WorkbenchMessage = {
    id: `result-${scope}`,
    taskId: `task-${scope}`,
    subtaskId: scope,
    turnId: `turn-${scope}`,
    attemptId: `turn-${scope}`,
    fileChangesCapture: capture,
    reviewEvidence: { ...reviewEvidenceFixture, threadId: scope, turnId: `turn-${scope}`, attemptId: `turn-${scope}` },
    role: 'assistant',
    status: 'done',
    createdAt: '2026-10-26T00:00:00Z',
    content: '已生成报告。请检查输出与验收要求。',
    blocks: [
      {
        id: `write-${scope}`,
        subtaskId: scope,
        type: 'tool',
        toolName: 'write',
        toolInput: { file_path: `report-${scope}.md` },
        toolOutput: 'written',
        status: 'done',
        createdAt: 1,
        completedAt: 2,
      },
      {
        id: `check-${scope}`,
        subtaskId: scope,
        type: 'tool',
        toolName: 'bash',
        toolInput: { command: 'pnpm test report-validation' },
        toolOutput: 'REPORT_ASSERTION_FAILED: expected total 42, received 41',
        status: 'error',
        createdAt: 1,
        completedAt: 2,
      },
    ],
  }
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-5 text-base text-text-primary">
      <p data-testid="preview-boundary">交互预览 · 示例数据，不代表原生验收</p>
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="preview-current-thread">{scope}</span>
        <Button
          variant="outline"
          data-testid="preview-switch-thread"
          onClick={() => setScope(value => (value === 'thread-A' ? 'thread-B' : 'thread-A'))}
        >
          切换示例会话
        </Button>
        <Button
          variant="ghost"
          data-testid="preview-late-reference"
          onClick={() =>
            setInsertion(current => ({
              id: (current?.id ?? 0) + 1,
              text: 'STALE_REFERENCE_FOR_THREAD_A',
              scopeKey: 'thread-A',
            }))
          }
        >
          投递旧会话示例引用
        </Button>
      </div>
      <MessageList
        messages={[message]}
        conversationKey={scope}
        onOpenWorkspaceFile={path => setOpenedFile(path)}
        onAddSelectionToConversation={text =>
          setInsertion(current => ({ id: (current?.id ?? 0) + 1, text, scopeKey: scope }))
        }
      />
      <p data-testid="preview-opened-file">{openedFile}</p>
      <BufferedChatInput
        value={drafts[scope] ?? ''}
        onChange={changeDraft}
        onSubmit={() => setSent(value => value + 1)}
        insertion={insertion}
        insertionScopeKey={scope}
      />
      <p data-testid="preview-send-count">{sent}</p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
