import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import en from '@/i18n/locales/en/taskDelivery.json'
import type { TaskDeliveryResult } from '../../../../shared/generated/contracts'
import type { TaskDeliveryApi, TaskDeliveryOwner } from '@/kcoder/taskDelivery'
import { TaskDeliveryPanel } from './TaskDeliveryPanel'
import { createTaskDeliveryDrafts } from '@/features/task-comparison/taskDeliveryDrafts'

const owner: TaskDeliveryOwner = {
  taskId: 'task-1',
  threadId: 'thread-1',
  deviceId: 'target-1',
  scope: 'account-1/target-1/task-1',
}
function snapshot(): TaskDeliveryResult {
  return {
    deliveryId: 'a'.repeat(64),
    threadId: owner.threadId,
    recipient: { taskId: 'source-task', threadId: 'source-thread', deviceId: 'target-1' },
    comparisonId: 'comparison-1',
    source: {
      repository: 'fixture/repo',
      branch: 'feature',
      headCommit: 'b'.repeat(40),
      baseBranch: 'main',
      baseCommit: 'c'.repeat(40),
      diffSha256: 'd'.repeat(64),
      workingSha256: 'e'.repeat(64),
      dirty: false,
    },
    draft: {
      title: 'Actual committed change',
      body: 'Native observations, not a commit CI certificate.',
    },
    nativeEvidenceIds: [],
    request: null,
    status: {
      pushState: 'unknown',
      pullRequest: null,
      ciState: 'unknown',
      checks: [],
      sourceChanged: false,
      checksTruncated: false,
      limitation: 'notRefreshed',
    },
  }
}
function fixtureApi() {
  return {
    prepare: vi.fn().mockResolvedValue(snapshot()),
    read: vi.fn().mockResolvedValue(snapshot()),
    request: vi.fn().mockImplementation(async (deliveryId, requestId, title, body) => ({
      ...snapshot(),
      deliveryId,
      draft: { title, body },
      request: { requestId, draftSha256: 'f'.repeat(64), prompt: 'Bound publication intent' },
    })),
    failure: vi.fn().mockResolvedValue({
      threadId: owner.threadId,
      recipient: snapshot().recipient,
      headCommit: 'b'.repeat(40),
      checkId: 'check:1',
      rawEvidence: 'actual bounded failure',
      truncated: false,
      prompt: 'Exact commit failure context',
    }),
  }
}
function mount(api: TaskDeliveryApi, onAddToDraft = vi.fn()) {
  return {
    ...render(
      <TaskDeliveryPanel
        owner={owner}
        supported
        originalTaskAvailable
        api={api}
        onAddToDraft={onAddToDraft}
      />
    ),
    onAddToDraft,
  }
}
beforeEach(async () => {
  i18n.addResourceBundle('en', 'taskDelivery', en, true, true)
  await i18n.changeLanguage('en')
})

describe('commit-bound delivery entry', () => {
  it('parks edited metadata across unmount and marks restored observations unknown until read', async () => {
    const drafts = createTaskDeliveryDrafts(), slot = drafts.slot('owner/response/source-B')
    const api = fixtureApi(), callback = vi.fn()
    const props = { owner, supported: true, originalTaskAvailable: true, api, onAddToDraft: callback, draftSlot: slot }
    const first = render(<TaskDeliveryPanel {...props} />)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.change(screen.getByTestId('task-delivery-title'), { target: { value: 'Retained PR title' } })
    fireEvent.change(screen.getByTestId('task-delivery-body'), { target: { value: 'Retained PR body' } })
    first.unmount()
    render(<TaskDeliveryPanel {...props} />)
    expect(screen.getByTestId('task-delivery-title')).toHaveValue('Retained PR title')
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Retained PR body')
    expect(screen.getByTestId('task-delivery-current-unknown')).toBeVisible()
    expect(screen.getByTestId('task-delivery-queue-publication')).toBeDisabled()
    expect(api.prepare).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('task-delivery-refresh'))
    await waitFor(() => expect(screen.queryByTestId('task-delivery-current-unknown')).not.toBeInTheDocument())
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Retained PR body')
    expect(callback).not.toHaveBeenCalled()
  })

  it('retains a pending stable request through close and late receipt without steering or replay', async () => {
    const slot = createTaskDeliveryDrafts().slot('pending-request'), api = fixtureApi(), callback = vi.fn()
    let resolveRequest: (value: TaskDeliveryResult) => void = () => {}
    api.request.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve }))
    const props = { owner, supported: true, originalTaskAvailable: true, api, onAddToDraft: callback, draftSlot: slot }
    const first = render(<TaskDeliveryPanel {...props} />)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.change(screen.getByTestId('task-delivery-title'), { target: { value: 'Pending edited title' } })
    fireEvent.click(screen.getByTestId('task-delivery-queue-publication'))
    const requestId = slot.getSnapshot().requestId
    expect(requestId).toBeTruthy()
    expect(slot.getSnapshot().requestUnknown).toBe(true)
    first.unmount()
    render(<TaskDeliveryPanel {...props} />)
    expect(screen.getByTestId('task-delivery-queue-publication')).toBeDisabled()
    const receipt = { ...snapshot(), request: { requestId: requestId!, draftSha256: 'f'.repeat(64), prompt: 'Original bound intent' } }
    await act(async () => { resolveRequest(receipt); await Promise.resolve() })
    await waitFor(() => expect(slot.getSnapshot().pending).toBeNull())
    expect(slot.getSnapshot().requestId).toBe(requestId)
    expect(slot.getSnapshot().delivery?.request?.requestId).toBe(requestId)
    expect(screen.getByTestId('task-delivery-title')).toHaveValue('Pending edited title')
    expect(callback).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('task-delivery-queue-publication'))
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('task-delivery-restore-request')).toBeDisabled()
    api.read.mockResolvedValue(receipt)
    fireEvent.click(screen.getByTestId('task-delivery-refresh'))
    await waitFor(() => expect(screen.getByTestId('task-delivery-restore-request')).toBeEnabled())
    expect(callback).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('task-delivery-restore-request'))
    expect(callback).toHaveBeenCalledExactlyOnceWith('Original bound intent', receipt.recipient)
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(slot.getSnapshot().requestId).toBe(requestId)
    expect(slot.getSnapshot().queued).toBe(true)
  })

  it('retains an uncertain draft append and requires a read plus explicit decision before restoring it', async () => {
    const api = fixtureApi(), slot = createTaskDeliveryDrafts().slot('append-uncertain')
    let appendFails = true
    const callback = vi.fn(() => { if (appendFails) throw Error('draft append outcome unconfirmed') })
    const props = { owner, supported: true, originalTaskAvailable: true, api, onAddToDraft: callback, draftSlot: slot }
    render(<TaskDeliveryPanel {...props} />)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.click(screen.getByTestId('task-delivery-queue-publication'))
    await screen.findByTestId('task-delivery-append-unknown')
    expect(slot.getSnapshot().queued).toBe(false)
    expect(slot.getSnapshot().appendUnknown).toBe(true)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('task-delivery-restore-request')).toBeDisabled()
    api.read.mockResolvedValue(slot.getSnapshot().delivery!)
    fireEvent.click(screen.getByTestId('task-delivery-refresh'))
    await waitFor(() => expect(screen.getByTestId('task-delivery-restore-request')).toBeEnabled())
    expect(callback).toHaveBeenCalledTimes(1)
    appendFails = false
    fireEvent.click(screen.getByTestId('task-delivery-restore-request'))
    expect(callback).toHaveBeenCalledTimes(2)
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(slot.getSnapshot().queued).toBe(true)
    expect(screen.queryByTestId('task-delivery-append-unknown')).not.toBeInTheDocument()
  })

  it('rejects another clients request id instead of overwriting the original unknown intent', async () => {
    const api = fixtureApi(), slot = createTaskDeliveryDrafts().slot('request-conflict'), callback = vi.fn()
    api.request.mockRejectedValue(Error('lost original receipt'))
    render(<TaskDeliveryPanel owner={owner} supported originalTaskAvailable api={api} draftSlot={slot} onAddToDraft={callback} />)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.click(screen.getByTestId('task-delivery-queue-publication'))
    await waitFor(() => expect(slot.getSnapshot().pending).toBeNull())
    const originalId = slot.getSnapshot().requestId
    expect(originalId).toBeTruthy()
    api.read.mockResolvedValue({ ...snapshot(), request: { requestId: 'different-client-request', draftSha256: 'f'.repeat(64), prompt: 'A different intent' } })
    fireEvent.click(screen.getByTestId('task-delivery-refresh'))
    await screen.findByRole('alert')
    await waitFor(() => expect(slot.getSnapshot().pending).toBeNull())
    expect(slot.getSnapshot().requestId).toBe(originalId)
    expect(slot.getSnapshot().requestUnknown).toBe(true)
    expect(slot.getSnapshot().uncertain).toBe(true)
    expect(screen.queryByTestId('task-delivery-restore-request')).not.toBeInTheDocument()
    expect(callback).not.toHaveBeenCalled()
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it('keeps committed hydration aliases in StrictMode without sharing a conflicting attempt or source', async () => {
    const cache = createTaskDeliveryDrafts(), api = fixtureApi()
    const firstSlot = cache.forResponse(owner.scope, { messageId: 'response', turnId: 'turn', attemptId: null }, true).slot('source-B')
    const props = { owner, supported: true, originalTaskAvailable: true, api, onAddToDraft: vi.fn() }
    const view = render(<StrictMode><TaskDeliveryPanel {...props} draftSlot={firstSlot} /></StrictMode>)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.change(screen.getByTestId('task-delivery-body'), { target: { value: 'Attempt one draft' } })
    const hydrated = cache.forResponse(owner.scope, { messageId: 'response', turnId: 'turn', attemptId: 'attempt-1' }, true).slot('source-B')
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} draftSlot={hydrated} /></StrictMode>)
    expect(hydrated.key).toBe(firstSlot.key)
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Attempt one draft')
    const downgraded = cache.forResponse(owner.scope, { messageId: 'response', turnId: null, attemptId: null }, false).slot('source-B')
    expect(downgraded.unavailable).toBe(true)
    expect(cache.forResponse(owner.scope, { messageId: 'response', turnId: null, attemptId: null }, false).slot('source-B')).toBe(downgraded)
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} draftSlot={downgraded} /></StrictMode>)
    expect(screen.queryByTestId('task-delivery-body')).not.toBeInTheDocument()
    const restored = cache.forResponse(owner.scope, { messageId: 'response', turnId: 'turn', attemptId: 'attempt-1' }, true).slot('source-B')
    expect(restored.key).toBe(firstSlot.key)
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} draftSlot={restored} /></StrictMode>)
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Attempt one draft')
    const conflict = cache.forResponse(owner.scope, { messageId: 'response', turnId: 'turn', attemptId: 'attempt-2' }, true).slot('source-B')
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} draftSlot={conflict} /></StrictMode>)
    expect(conflict.key).not.toBe(firstSlot.key)
    expect(screen.queryByTestId('task-delivery-body')).not.toBeInTheDocument()
    const rebound = cache.forResponse(owner.scope, { messageId: 'hydrated-response', turnId: 'turn', attemptId: 'attempt-1' }, true).slot('source-B')
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} draftSlot={rebound} /></StrictMode>)
    expect(rebound.key).toBe(firstSlot.key)
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Attempt one draft')
    const otherSource = cache.forResponse(owner.scope, { messageId: 'hydrated-response', turnId: 'turn', attemptId: 'attempt-1' }, true).slot('source-C')
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} draftSlot={otherSource} /></StrictMode>)
    expect(screen.queryByTestId('task-delivery-body')).not.toBeInTheDocument()
    const otherOwner = cache.forResponse('another-account/target/task', { messageId: 'hydrated-response', turnId: 'turn', attemptId: 'attempt-1' }, true).slot('source-B')
    expect(otherOwner.key).not.toBe(firstSlot.key)
    view.rerender(<StrictMode><TaskDeliveryPanel {...props} owner={{ ...owner, scope: 'another-account/target/task' }} draftSlot={otherOwner} /></StrictMode>)
    expect(screen.queryByTestId('task-delivery-body')).not.toBeInTheDocument()
  })

  it('invalidates the prepared base relation immediately after the base input changes', async () => {
    const api = fixtureApi()
    mount(api)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.change(screen.getByTestId('task-delivery-base'), { target: { value: 'release' } })
    expect(screen.getByTestId('task-delivery-queue-publication')).toBeDisabled()
    fireEvent.click(screen.getByTestId('task-delivery-queue-publication'))
    expect(api.request).not.toHaveBeenCalled()
  })

  it('prepares editable metadata and queues a bound publication intent only after an explicit click', async () => {
    const api = fixtureApi()
    const { onAddToDraft } = mount(api)
    expect(api.prepare).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en.prepare))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.change(screen.getByLabelText(en.prTitle), { target: { value: 'Edited title' } })
    fireEvent.change(screen.getByLabelText(en.prBody), { target: { value: 'Edited body' } })
    fireEvent.click(screen.getByText(en.queuePublication))
    await waitFor(() =>
      expect(onAddToDraft).toHaveBeenCalledWith('Bound publication intent', snapshot().recipient)
    )
    expect(api.request).toHaveBeenCalledWith(
      'a'.repeat(64),
      expect.any(String),
      'Edited title',
      'Edited body'
    )
    expect(screen.getByText(en.queuePublication)).toBeDisabled()
    expect(api.prepare).toHaveBeenCalledTimes(1)
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it('retains edits across status refresh and does not replay a lost request receipt', async () => {
    const api = fixtureApi()
    api.request.mockRejectedValue(new Error('transport lost'))
    const { onAddToDraft } = mount(api)
    fireEvent.click(screen.getByText(en.prepare))
    await screen.findByDisplayValue('Actual committed change')
    fireEvent.change(screen.getByLabelText(en.prBody), {
      target: { value: 'Keep this unsent edit' },
    })
    fireEvent.click(screen.getByText(en.queuePublication))
    await screen.findByRole('alert')
    expect(screen.getByLabelText(en.prBody)).toHaveValue('Keep this unsent edit')
    fireEvent.click(screen.getByText(en.queuePublication))
    fireEvent.click(screen.getByText(en.refresh))
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText(en.prBody)).toHaveValue('Keep this unsent edit')
    expect(onAddToDraft).not.toHaveBeenCalled()
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it('ignores a late original-owner request after switching targets and never steers another task', async () => {
    const api = fixtureApi()
    let finish!: (value: TaskDeliveryResult) => void
    api.prepare.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const { rerender, onAddToDraft } = mount(api)
    fireEvent.click(screen.getByText(en.prepare))
    rerender(
      <TaskDeliveryPanel
        owner={{
          taskId: 'task-2',
          threadId: 'thread-2',
          deviceId: 'target-2',
          scope: 'account-2/target-2/task-2',
        }}
        supported
        originalTaskAvailable
        api={fixtureApi()}
        onAddToDraft={onAddToDraft}
      />
    )
    await act(async () => finish(snapshot()))
    expect(screen.queryByDisplayValue('Actual committed change')).not.toBeInTheDocument()
    expect(onAddToDraft).not.toHaveBeenCalled()
  })

  it('pages checks and adds only the selected failed check with the exact commit to the original draft', async () => {
    const api = fixtureApi()
    const result = snapshot()
    result.status.checks = Array.from({ length: 11 }, (_, i) => ({
      checkId: `check:${i + 1}`,
      name: `Check ${i + 1}`,
      headCommit: result.source.headCommit,
      state: 'failed' as const,
      detailsUrl: null,
    }))
    api.prepare.mockResolvedValue(result)
    const { onAddToDraft } = mount(api)
    fireEvent.click(screen.getByText(en.prepare))
    await screen.findByText('Check 1 · CI failed')
    expect(screen.getAllByText(en.queueFailure)).toHaveLength(10)
    fireEvent.click(screen.getAllByText(en.queueFailure)[0])
    await waitFor(() =>
      expect(onAddToDraft).toHaveBeenCalledWith(
        'Exact commit failure context',
        snapshot().recipient
      )
    )
    expect(api.failure).toHaveBeenCalledWith(result.deliveryId, 'check:1')
    fireEvent.click(screen.getByText(en.next))
    expect(screen.getAllByText(en.queueFailure)).toHaveLength(1)
    expect(screen.getByText('Check 11 · CI failed')).toBeInTheDocument()
  })

  it('shows skipped and neutral checks separately and never presents them as passing CI', async () => {
    const api = fixtureApi()
    const result = snapshot()
    result.status.checks = [
      {
        checkId: 'check:2',
        name: 'Skipped fixture',
        headCommit: result.source.headCommit,
        state: 'skipped',
        detailsUrl: null,
      },
      {
        checkId: 'check:3',
        name: 'Neutral fixture',
        headCommit: result.source.headCommit,
        state: 'neutral',
        detailsUrl: null,
      },
    ]
    api.prepare.mockResolvedValue(result)
    mount(api)
    fireEvent.click(screen.getByText(en.prepare))
    await screen.findByText('Skipped fixture · Check skipped')
    expect(screen.getByText('Neutral fixture · Check neutral')).toBeInTheDocument()
    expect(screen.queryByText(en.ci.passed)).not.toBeInTheDocument()
    expect(
      screen.getByText('Publication and fixes go to task source-task (target-1).')
    ).toBeInTheDocument()
  })

  it('explains old-target and unavailable-original-task limits without executing a request', () => {
    const api = fixtureApi()
    const { rerender } = render(
      <TaskDeliveryPanel owner={owner} supported={false} originalTaskAvailable api={api} />
    )
    expect(screen.getByText(en.unsupported)).toBeInTheDocument()
    rerender(<TaskDeliveryPanel owner={owner} supported originalTaskAvailable={false} api={api} />)
    expect(screen.getByText(en.originalUnavailable)).toBeInTheDocument()
    expect(api.prepare).not.toHaveBeenCalled()
  })
  it('projects current PR and CI as unknown after a failed refresh while retaining the source and draft', async () => {
    const api = fixtureApi()
    const observed = snapshot()
    observed.status.ciState = 'passed'
    observed.status.pushState = 'pushed'
    observed.status.checks = [
      {
        checkId: 'green-old',
        name: 'Old green check',
        headCommit: observed.source.headCommit,
        state: 'passed',
        detailsUrl: null,
      },
    ]
    api.prepare.mockResolvedValue(observed)
    api.read.mockRejectedValue(new Error('selected source changed'))
    mount(api)
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Actual committed change')
    expect(screen.getByText(`Old green check · ${en.ci.passed}`)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(en.prBody), {
      target: { value: 'Keep my edited draft' },
    })
    fireEvent.click(screen.getByTestId('task-delivery-refresh'))
    await screen.findByTestId('task-delivery-current-unknown')
    expect(screen.queryByText(`Old green check · ${en.ci.passed}`)).not.toBeInTheDocument()
    expect(screen.getByLabelText(en.prBody)).toHaveValue('Keep my edited draft')
    expect(screen.getByTestId('task-delivery-queue-publication')).toBeDisabled()
  })
})
