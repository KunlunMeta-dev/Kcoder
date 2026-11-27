import { useState } from 'react'
import { ProjectChatComposer } from '../../src/components/chat/composer/ProjectChatComposer'
import { ComposerLayoutTransition } from '../../src/components/chat/composer/ComposerLayoutTransition'
import type { DeviceInfo, ProjectWithTasks, UnifiedModel } from '../../src/types/api'

const project: ProjectWithTasks = {
  id: 1,
  name: '当前计算机',
  tasks: [],
  config: {
    mode: 'workspace',
    execution: { targetType: 'local', deviceId: 'local' },
    workspace: { source: 'git', checkoutPath: '/fixture' },
  },
}
const device: DeviceInfo = {
  id: 1,
  device_id: 'local',
  name: '当前计算机',
  status: 'online',
  is_default: true,
  device_type: 'local',
  bind_shell: 'kcoder',
  executor_version: '1.0.0',
}
const model: UnifiedModel = {
  name: 'fixture-model',
  modelId: 'fixture-model',
  type: 'runtime',
  provider: 'local',
}
const noop = () => {}

/** Real composer controls with synthetic readiness; no task, model or platform execution. */
export function ComposerTransitionFixture() {
  const [stage, setStage] = useState(0)
  const [draft, setDraft] = useState('保留输入草稿')
  const [modelReady, setModelReady] = useState(false)
  const running = stage === 2
  return (
    <main className="flex h-dvh flex-col bg-background p-6 text-text-primary">
      <div className="flex gap-4">
        <button
          data-testid="fixture-composer-ready"
          onClick={() => {
            setStage(1)
            setModelReady(true)
          }}
        >
          完成加载
        </button>
        <button
          data-testid="fixture-composer-start"
          onClick={() => {
            setDraft('')
            setStage(2)
            setModelReady(false)
          }}
        >
          进入会话
        </button>
        <button data-testid="fixture-composer-model-ready" onClick={() => setModelReady(true)}>
          恢复模型
        </button>
      </div>
      <div className="mt-auto pb-4" data-testid="desktop-workbench-content">
        <ComposerLayoutTransition
          active
          scopeKey="fixture-local"
          chromeKey={`${stage}:${modelReady}`}
        >
          <ProjectChatComposer
            key={running ? 'conversation' : 'draft'}
            value={draft}
            onChange={setDraft}
            onSubmit={noop}
            disabled={false}
            placeholder={running ? '要求后续变更' : '随心输入'}
            models={modelReady ? [model] : []}
            selectedModel={modelReady ? model : null}
            isModelSelectionReady={modelReady}
            isStreaming={running}
            onPause={noop}
            projectWork={
              running
                ? undefined
                : {
                    projects: [project],
                    devices: [device],
                    currentProject: project,
                    currentProjectId: 1,
                    executionMode: 'current_workspace',
                    isGitProject: stage === 0 ? undefined : false,
                    branchLoading: stage === 0,
                    onListBranches: async () => ['main'],
                    onCheckoutBranch: async () => {},
                    onSelectProject: noop,
                    onSelectStandaloneDevice: noop,
                    onExecutionModeChange: noop,
                  }
            }
            showProjectWorkBar={!running}
          />
        </ComposerLayoutTransition>
      </div>
    </main>
  )
}
