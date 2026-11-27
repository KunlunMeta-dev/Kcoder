import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RecoverRuntimeTask } from '../../src/features/workbench/workbenchContextTypes'
import { FailedTaskRecovery } from '../../src/components/layout/sidebar/FailedTaskRecovery'
import type {
  RuntimeTaskAddress,
  RuntimeTaskCreationReadResponse,
  RuntimeTaskSummary,
} from '../../src/types/api'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'

type RecoveryMode = 'unknown' | 'ready-message-unknown'

const fixtureAddress: RuntimeTaskAddress = {
  deviceId: 'fixture-device',
  taskId: 'kcoder:fixture-device:fixture-task',
  workspacePath: '/fixture/workspace',
}

const fixtureTask: RuntimeTaskSummary = {
  taskId: fixtureAddress.taskId,
  title: 'Synthetic failed task',
  runtime: 'kcoder',
  workspacePath: fixtureAddress.workspacePath!,
  status: 'failed',
  updatedAt: '2026-11-13T10:00:00.000Z',
  creationRequest: {
    clientRequestId: 'fixture-client-request',
    clientMessageId: 'fixture-client-message',
    outcome: 'unknown',
    failedAt: '2026-11-13T09:00:00.000Z',
  },
  error: `Synthetic fixture error: ${'E'.repeat(1536)}`,
}

function readyResponse(): RuntimeTaskCreationReadResponse {
  return {
    status: 'ready',
    address: {
      deviceId: fixtureAddress.deviceId,
      taskId: 'kcoder:fixture-device:recovered-thread',
      threadId: 'recovered-thread',
      workspacePath: fixtureAddress.workspacePath!,
    },
    initialMessage: { status: 'unknown' },
  }
}

export function Fixture() {
  const isChinese = i18n.language.startsWith('zh')
  const [mode, setMode] = useState<RecoveryMode>('unknown')
  const [deviceStatus, setDeviceStatus] = useState<'unknown' | 'online'>('unknown')
  const [taskUpdatedAt, setTaskUpdatedAt] = useState(fixtureTask.updatedAt)
  const [queryCalls, setQueryCalls] = useState(0)
  const [openCalls, setOpenCalls] = useState(0)
  const [navigateCalls, setNavigateCalls] = useState(0)
  const onRecover: RecoverRuntimeTask = async (address, open = false) => {
    if (address.deviceId !== fixtureAddress.deviceId || address.taskId !== fixtureAddress.taskId) {
      throw new Error('Unexpected synthetic recovery owner')
    }
    if (open) {
      setOpenCalls(value => value + 1)
      return readyResponse()
    }
    setQueryCalls(value => value + 1)
    return mode === 'unknown' ? { status: 'unknown' } : readyResponse()
  }

  return (
    <main
      data-testid="fixture-root"
      className="mx-auto box-border min-h-screen bg-background text-text-primary"
      style={{ width: 'min(100%, 320px)', boxSizing: 'border-box' }}
    >
      <div className="space-y-3 p-3">
        <h1 className="text-base font-semibold">
          {isChinese ? '合成失败任务恢复' : 'Synthetic failed task recovery'}
        </h1>
        <p data-testid="fixture-scope" className="text-xs text-text-secondary">
          {isChinese
            ? '仅 UI fixture：记录本地回调，不连接后端或模型。'
            : 'UI-only fixture. It records local callbacks and does not connect to a backend or model.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="target-status-unknown"
            className="min-h-11 rounded border border-border px-3"
            onClick={() => {
              setDeviceStatus('unknown')
              setTaskUpdatedAt('2026-11-13T10:00:00.000Z')
            }}
          >
            {isChinese ? '将目标状态设为未知' : 'Set target status unknown'}
          </button>
          <button
            type="button"
            data-testid="target-status-online"
            className="min-h-11 rounded border border-border px-3"
            onClick={() => {
              setDeviceStatus('online')
              setTaskUpdatedAt('2026-11-13T12:00:00.000Z')
            }}
          >
            {isChinese ? '将目标状态设为在线' : 'Set target status online'}
          </button>
          <button
            type="button"
            data-testid="mode-unknown"
            className="min-h-11 rounded border border-border px-3"
            onClick={() => setMode('unknown')}
          >
            {isChinese ? '查询返回未知结果' : 'Use unknown result'}
          </button>
          <button
            type="button"
            data-testid="mode-ready-message-unknown"
            className="min-h-11 rounded border border-border px-3"
            onClick={() => setMode('ready-message-unknown')}
          >
            {isChinese ? '找到会话，但首条消息未知' : 'Use found conversation with unknown message'}
          </button>
        </div>
        <div className="sr-only" aria-hidden="true">
          <output data-testid="query-calls">{queryCalls}</output>
          <output data-testid="open-calls">{openCalls}</output>
          <output data-testid="navigate-calls">{navigateCalls}</output>
          <output data-testid="task-updated-at">{taskUpdatedAt}</output>
        </div>
        <section
          data-testid="recovery-frame"
          className="box-border w-full min-w-0"
          style={{ width: '100%', maxWidth: '320px', boxSizing: 'border-box' }}
        >
          <FailedTaskRecovery
            key={mode}
            task={{ ...fixtureTask, updatedAt: taskUpdatedAt }}
            address={fixtureAddress}
            available={deviceStatus === 'online'}
            deviceStatus={deviceStatus}
            onRecover={onRecover}
            onNavigate={() => setNavigateCalls(value => value + 1)}
          />
        </section>
      </div>
    </main>
  )
}

const params = new URLSearchParams(window.location.search)
const locale = params.get('locale') === 'en' ? 'en' : 'zh-CN'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.setAttribute('data-theme', theme)
const root = createRoot(document.getElementById('root')!)
void i18n.changeLanguage(locale).finally(() => root.render(<Fixture />))
