import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '@/i18n'
import { TaskCapabilityScopePicker } from '@/features/connectivity/TaskCapabilityScopePicker'
import { TaskCapabilityScopeSelector } from '@/features/connectivity/TaskCapabilityScopeSelector'
import '@/styles/globals.css'

await i18n.changeLanguage('zh-CN')

const snapshot = {
  threadId: 'preview-original-thread',
  revision: 4,
  selection: { mode: 'none' as const, sources: [] },
  effectiveSources: [],
  effectiveFrom: 'current_snapshot' as const,
}
const target = {
  initialAttempt: {
    threadId: snapshot.threadId,
    turnId: 'preview-original-turn',
    attemptId: 'preview-original-attempt',
  },
}

export function TaskCapabilityScopePreview() {
  const [selected, setSelected] = useState(false)
  return (
    <main className="min-h-screen bg-background px-5 py-6 text-text-primary">
      <div className="mx-auto grid max-w-3xl gap-5">
        <header className="grid gap-2">
          <p className="text-sm text-text-muted">KCoder Studio / 任务工作台</p>
          <h1 className="text-lg font-medium">任务工具与资源范围</h1>
          <p className="text-sm text-text-secondary">
            受控界面预览 · 已保存记录为 fixture；未启动任务、连接平台或调用模型。
          </p>
        </header>
        <TaskCapabilityScopeSelector
          ownerKey="preview-owner"
          loadPage={async () => ({
            entries: [
              {
                referenceId: 'preview-native-saved-01',
                target,
                title: '季度资料整理',
                detail: '原会话 · 任务工具与资源范围已保存',
                savedSnapshot: snapshot,
                observationState: 'saved_only',
                reasonCode: 'TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED',
              },
              {
                referenceId: 'preview-native-saved-02',
                target,
                title: '运营数据复核',
                detail: '原会话 · 等待安全边界',
                savedSnapshot: { ...snapshot, revision: 6, effectiveFrom: 'next_tool_boundary' as const },
                observationState: 'saved_only',
                reasonCode: 'TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED',
              },
              {
                referenceId: 'preview-native-unknown',
                target: null,
                title: '待核对的范围记录',
                savedSnapshot: null,
                observationState: 'unknown',
                reasonCode: 'TASK_CAPABILITY_SCOPE_SAVED_RECORD_UNREADABLE',
              },
            ],
            nextCursor: null,
            observationState: 'saved_only',
            reasonCode: null,
          })}
          onChoose={async () => setSelected(true)}
        />
        {selected && (
          <TaskCapabilityScopePicker
            ownerKey="preview-owner"
            snapshot={snapshot}
            descriptors={[]}
            catalogState="unknown"
            onCommit={async () => {
              throw new Error('PREVIEW_HAS_NO_MUTATING_NATIVE_PROVIDER')
            }}
          />
        )}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<TaskCapabilityScopePreview />)
