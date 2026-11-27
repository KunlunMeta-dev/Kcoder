import { useLayoutEffect, useRef, useState } from 'react'
import { ProjectChatComposer } from '../../src/components/chat/composer/ProjectChatComposer'
import { useResizableRightSplitChat } from '../../src/components/layout/workspace-panels/useResizableWorkspacePanel'
import { WorkspacePanelActions } from '../../src/components/layout/workspace-panels/WorkspacePanelActions'
import { TaskExpertControl } from '../../src/features/experts/TaskExpertControl'
import { ComputerUseSubmit } from '../../src/features/computer-use/ComputerUseSubmit'
import { WorkflowReusePicker } from '../../src/features/workflows/WorkflowReusePicker'
import { computerUseConsent, useComputerUseConsent } from '../../src/kcoder/computerUseConsent'
import { useWorkbenchAttachments } from '../../src/features/workbench/useWorkbenchAttachments'
import type { Attachment } from '../../src/types/api'

const fixtureProject = {
  id: 7,
  name: 'Fixture project',
  tasks: [],
  config: {
    mode: 'workspace' as const,
    execution: { targetType: 'local' as const, deviceId: 'fixture-device' },
    workspace: { source: 'git' as const, checkoutPath: '/fixture/project' },
  },
}

const fixtureDevice = {
  id: 1,
  device_id: 'fixture-device',
  name: 'Current computer',
  status: 'online' as const,
  is_default: true,
  device_type: 'local' as const,
  bind_shell: 'claudecode',
  executor_version: '1.8.5',
  client_ip: '127.0.0.1',
}

const fixtureProjectWork = {
  projects: [fixtureProject],
  devices: [fixtureDevice],
  currentProject: fixtureProject,
  currentProjectId: fixtureProject.id,
  currentStandaloneDeviceId: null,
  selectedDeviceWorkspaceId: null,
  executionMode: 'current_workspace' as const,
  onSelectProject: () => {},
  onSelectStandaloneDevice: () => {},
  onExecutionModeChange: () => {},
  branchName: null,
  branchLoading: true,
  onListBranches: () => new Promise<string[]>(() => {}),
  onCheckoutBranch: async () => {},
}

/** Real controls, synthetic target and draft; never submits or controls a desktop. */
export function ComposerActionsFixture() {
  return new URLSearchParams(location.search).get('attachments') === 'true'
    ? <ComposerAttachmentsFixture />
    : <DefaultComposerActionsFixture />
}

/** Actual picker validation and previews; a controlled transport never uploads. */
function ComposerAttachmentsFixture() {
  const pending = useRef<(() => void)[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [draft, setDraft] = useState('Two images')
  const selection = useWorkbenchAttachments({
    uploadAttachment: file => new Promise<Attachment>(resolve => {
      const id = -(pending.current.length + 1)
      pending.current.push(() => resolve({
        id, filename: file.name, file_size: file.size, status: 'ready',
        mime_type: file.type, file_extension: '.png', created_at: new Date().toISOString(),
        local_preview_url: URL.createObjectURL(file),
      }))
      setPendingCount(pending.current.length)
    }),
  })
  return (
    <main className="flex min-h-dvh flex-col gap-3 bg-background p-3 text-text-primary">
      <input type="file" multiple data-testid="fixture-image-picker"
        onChange={event => void selection.handleFileSelect(Array.from(event.target.files ?? []))} />
      <button data-testid="fixture-finish-second" onClick={() => pending.current[1]?.()}>Finish second</button>
      <button data-testid="fixture-finish-first" onClick={() => pending.current[0]?.()}>Finish first</button>
      <output data-testid="fixture-upload-count">{selection.uploadingFiles.size}</output>
      <output data-testid="fixture-transport-count">{pendingCount}</output>
      <output data-testid="fixture-image-order">{selection.attachments.map(a => a.id).join(',')}</output>
      <ProjectChatComposer value={draft} onChange={setDraft} onSubmit={() => {}} disabled={false}
        models={[]} selectedModel={null} isModelSelectionReady
        attachments={selection.attachments} uploadingFiles={selection.uploadingFiles}
        attachmentErrors={selection.errors} onFileSelect={selection.handleFileSelect}
        onCancelUpload={selection.cancelUpload} onRemoveAttachment={selection.removeAttachment} />
    </main>
  )
}

function DefaultComposerActionsFixture() {
  const [draft, setDraft] = useState('')
  const enabled = useComputerUseConsent('local', 'fixture-task')
  const params = new URLSearchParams(location.search)
  const showProjectWorkBar = params.get('workbar') === 'true'
  const paneWidth = Number(params.get('paneWidth'))
  const splitPane = params.get('splitPane') === 'true'
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const { width: chatColumnWidth, handleResizeStart } = useResizableRightSplitChat({
    containerRef: workbenchRef,
    onCollapse: () => setRightPanelOpen(false),
  })
  useLayoutEffect(() => {
    document.documentElement.dataset.theme =
      new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
  }, [])
  const composer = (
    <ProjectChatComposer
      value={draft}
      onChange={setDraft}
      onSubmit={() => {}}
      disabled={false}
      models={[]}
      selectedModel={null}
      isModelSelectionReady
      showProjectWorkBar={showProjectWorkBar}
      projectWork={showProjectWorkBar ? fixtureProjectWork : undefined}
      toolbarLeadingContext={
        <TaskExpertControl address={null} deviceId="local" workspacePath="/fixture" />
      }
      modeStatus={
        <>
          <ComputerUseSubmit
            serverId="local"
            taskId="fixture-task"
            prompt={draft}
            disabled={false}
            onConfirm={() => {}}
          />
          <WorkflowReusePicker serverId="local" disabled={false} onInsert={setDraft} />
        </>
      }
    />
  )
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background p-3 text-text-primary">
      <label><input type="checkbox" data-testid="fixture-desktop-enabled" checked={enabled}
        onChange={event => computerUseConsent.set('local', 'fixture-task', event.target.checked)} />
        Synthetic desktop consent
      </label>
      {splitPane ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col pt-2">
          <div className="mb-2 flex h-10 shrink-0 items-center">
            <WorkspacePanelActions
              mode="right-panel-toggle"
              environmentInfo={{ additions: '+0', deletions: '-0', executionTarget: 'local' }}
              environmentInfoPopoverContainer={null}
              environmentInfoOpen={false}
              onEnvironmentInfoOpenChange={() => {}}
              onRefreshEnvironmentInfo={async () => {}}
              onCommitEnvironmentChanges={async () => {}}
              onCommitAndPushEnvironmentChanges={async () => {}}
              onPushEnvironmentChanges={async () => {}}
              onListEnvironmentBranches={async () => []}
              onCheckoutEnvironmentBranch={async () => {}}
              onCreateEnvironmentBranch={async () => {}}
              onOpenEnvironmentChangesReview={() => {}}
              rightPanelOpen={rightPanelOpen}
              bottomPanelOpen={false}
              onToggleRightPanel={() => setRightPanelOpen(open => !open)}
              onToggleBottomPanel={() => {}}
            />
          </div>
          <div
            ref={workbenchRef}
            data-testid="fixture-workbench-split"
            className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <div
              data-testid="fixture-chat-pane"
              className="flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
              style={{ width: rightPanelOpen ? `${chatColumnWidth}px` : '100%' }}
            >
              <div data-testid="fixture-composer-host" className="mt-auto w-full min-w-0">
                {composer}
              </div>
            </div>
            {rightPanelOpen && (
              <div
                data-testid="fixture-right-workspace-resize-handle"
                role="separator"
                aria-orientation="vertical"
                className="absolute inset-y-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize"
                style={{ left: chatColumnWidth }}
                onPointerDown={handleResizeStart}
              />
            )}
            <aside
              data-testid="fixture-right-panel-shell"
              aria-hidden={!rightPanelOpen}
              className={
                rightPanelOpen
                  ? 'min-w-0 shrink-0 overflow-hidden border-l border-border/60'
                  : 'min-w-0 shrink-0 overflow-hidden'
              }
              style={{ width: rightPanelOpen ? `calc(100% - ${chatColumnWidth}px)` : '0px' }}
            >
              <div className="space-y-2 p-4">
                <div>审查</div>
                <div>终端</div>
                <div>浏览器</div>
                <div>文件</div>
              </div>
            </aside>
          </div>
        </section>
      ) : (
        <div
          data-testid="fixture-composer-host"
          className="mt-auto min-w-0 max-w-full"
          style={paneWidth > 0 ? { width: `${paneWidth}px` } : undefined}
        >
          {composer}
        </div>
      )}
    </main>
  )
}
