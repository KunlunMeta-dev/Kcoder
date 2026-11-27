import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationHistory } from './useMigrationHistory'

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['historyDiscover', 'historySources', 'historyCreate', 'historyRead', 'historyRun', 'historyCancel', 'historyResume', 'historyJobs'].map(name => [name, vi.fn()])) }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const page = { catalogId: 'catalog', items: [], totalItems: 12, nextCursor: 'catalog:10', discoveryComplete: true, problems: [] }
const job = { jobId: 'job', sequence: 0, source: 'codex', stage: 'capturing', archiveId: null, archived: false, normalization: null, failureCode: null, cancelRequested: false }
const accepted = { job, workerRunning: false, progress: null, workerError: null }
beforeEach(() => {
  vi.resetAllMocks()
  api.historyDiscover.mockResolvedValue(page)
  api.historyCreate.mockResolvedValue(accepted)
  api.historyRun.mockResolvedValue({ ...accepted, workerRunning: true })
  api.historyRead.mockResolvedValue(accepted)
  api.historyJobs.mockResolvedValue({ jobs: [], nextCursor: null })
})

test('a lost creation reply is reconciled by the original identity before running the archive', async () => {
  api.historyCreate.mockRejectedValue(new Error('connection lost'))
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.discover())
  await act(() => result.current.importSource('selection'))
  const request = api.historyCreate.mock.calls[0][0]
  expect(request).toMatchObject({ catalogId: 'catalog', sourceHandle: 'selection' })
  expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/)
  expect(api.historyRead).toHaveBeenCalledWith(request.requestId)
  expect(api.historyRun).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', expectedSequence: 0 })
  expect(result.current.active?.workerRunning).toBe(true)
  expect(api.historyCreate).toHaveBeenCalledTimes(1)
})

test('target changes fence delayed creation receipts and never start work on another account', async () => {
  let finish!: (value: unknown) => void
  let current = true
  api.historyCreate.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => current))
  await act(() => result.current.discover())
  let pending!: Promise<boolean>
  act(() => { pending = result.current.importSource('selection') })
  await waitFor(() => expect(api.historyCreate).toHaveBeenCalledOnce())
  current = false
  await act(async () => { finish(accepted); await pending })
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(result.current.active).toBeNull()
})

test('cancel acknowledgements outrank late observations and explicit resume uses the journal sequence', async () => {
  api.historyCancel.mockResolvedValue({ ...accepted, job: { ...job, sequence: 4, stage: 'cancelled', cancelRequested: true } })
  api.historyResume.mockResolvedValue({ ...accepted, job: { ...job, sequence: 5 } })
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.discover())
  await act(() => result.current.importSource('selection'))
  await act(() => result.current.cancel())
  expect(result.current.active?.job.stage).toBe('cancelled')
  await act(() => result.current.open('job'))
  expect(result.current.active?.job.sequence).toBe(4)
  api.historyRun.mockResolvedValue({ ...accepted, job: { ...job, sequence: 5 }, workerRunning: true })
  await act(() => result.current.resume())
  expect(api.historyResume).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', expectedSequence: 4 })
  expect(api.historyRun).toHaveBeenLastCalledWith({ jobId: 'job', expectedSequence: 5 })
})

test('source and job pagination forward opaque target cursors, not host paths or local indexes', async () => {
  api.historySources.mockResolvedValue({ ...page, items: [], nextCursor: null })
  api.historyJobs.mockResolvedValue({ jobs: [], nextCursor: 'job-cursor' })
  const { result } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.discover())
  await act(() => result.current.sourcePage('catalog:10'))
  expect(api.historySources).toHaveBeenCalledExactlyOnceWith({ catalogId: 'catalog', cursor: 'catalog:10' })
  await act(() => result.current.listJobs('job-cursor'))
  expect(api.historyJobs).toHaveBeenCalledExactlyOnceWith({ cursor: 'job-cursor' })
})

test('an older stopped poll cannot strand a newer running checkpoint',async()=>{
  const live={...accepted,job:{...job,sequence:5,stage:'normalizing'},workerRunning:true}
  api.historyRun.mockResolvedValue(live)
  let finish!:(value:unknown)=>void
  api.historyRead.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const {result}=renderHook(()=>useMigrationHistory('target','/owned',()=>true))
  await act(()=>result.current.discover());await act(()=>result.current.importSource('selection'))
  await waitFor(()=>expect(finish).toBeTypeOf('function'))
  api.historyRead.mockResolvedValueOnce({...live,job:{...live.job,sequence:7}})
  await act(()=>result.current.open('job'))
  api.historyRead.mockResolvedValue({...live,workerRunning:false,job:{...live.job,sequence:8,stage:'normalized'}})
  await act(async()=>{finish({...live,workerRunning:false});await Promise.resolve()})
  await waitFor(()=>expect(result.current.active?.job.stage).toBe('normalized'),{timeout:2000})
})

test('a normalized projection requiring recovery waits for an explicit run with its confirmed sequence',async()=>{
  const damaged={...accepted,job:{...job,sequence:11,stage:'normalized',failureCode:'history_projection_recovery_required'},workerRunning:false}
  api.historyRead.mockResolvedValue(damaged)
  api.historyRun.mockResolvedValue({...damaged,job:{...damaged.job,sequence:12,failureCode:null},workerRunning:false})
  const {result}=renderHook(()=>useMigrationHistory('target','/owned',()=>true))
  await act(()=>result.current.open('job'))
  expect(result.current.active?.job.sequence).toBe(11);expect(api.historyRun).not.toHaveBeenCalled()
  await act(()=>result.current.resume())
  expect(api.historyRun).toHaveBeenCalledExactlyOnceWith({jobId:'job',expectedSequence:11})
  expect(api.historyResume).not.toHaveBeenCalled();expect(result.current.active?.job.failureCode).toBeNull()
})

test('a transient typed catalog busy response retries observation without replaying a run',async()=>{
  const live={...accepted,job:{...job,sequence:5,stage:'normalizing'},workerRunning:true}
  api.historyRun.mockResolvedValue(live)
  api.historyRead.mockRejectedValueOnce(new Error('history_catalog_busy')).mockResolvedValue({...live,workerRunning:false,job:{...live.job,sequence:6,stage:'normalized'}})
  const {result}=renderHook(()=>useMigrationHistory('target','/owned',()=>true))
  await act(()=>result.current.discover());await act(()=>result.current.importSource('selection'))
  await waitFor(()=>expect(result.current.active?.job.stage).toBe('normalized'),{timeout:2000})
  expect(api.historyRun).toHaveBeenCalledOnce();expect(api.historyRead).toHaveBeenCalledTimes(2)
})


test('an unknown owner cannot be started through the controller even when workerRunning is false', async () => {
  api.historyRead.mockResolvedValue({ ...accepted, workerState: 'unknown' })
  const { result, unmount } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.open('job'))
  await act(() => result.current.resume())
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(api.historyResume).not.toHaveBeenCalled()
  expect(result.current.error).toBe('history_job_execution_unknown')
  unmount()
})

test('legacy batch-owned checkpoints keep read-only observation without starting the child', async () => {
  api.historyRead.mockResolvedValueOnce(accepted).mockResolvedValue({ ...accepted, job: { ...job, sequence: 2, stage: 'normalized' } })
  const { result, unmount } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.open('job'))
  await waitFor(() => expect(result.current.active?.job.stage).toBe('normalized'), { timeout: 2000 })
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(api.historyResume).not.toHaveBeenCalled()
  expect(api.historyCreate).not.toHaveBeenCalled()
  unmount()
})

test('a newer unknown execution observation prevents a stale stopped selection from starting', async () => {
  api.historyRead.mockResolvedValueOnce({ ...accepted, workerState: 'stopped' }).mockResolvedValue({ ...accepted, workerState: 'unknown' })
  const { result, unmount } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.open('job'))
  await act(() => result.current.resume())
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(api.historyResume).not.toHaveBeenCalled()
  expect(result.current.active?.workerState).toBe('unknown')
  unmount()
})

test('explicit cancelled legacy recovery rechecks its reason and does not automatically run', async () => {
  const legacy = { ...accepted, job: { ...job, cancelRequested: true }, workerState: 'unknown', workerError: 'history_job_execution_untracked' }
  api.historyRead.mockResolvedValue(legacy)
  api.historyResume.mockResolvedValue({ ...accepted, workerState: 'stopped', job: { ...job, sequence: 1 } })
  const { result, unmount } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.open('job'))
  await act(() => result.current.resume())
  expect(api.historyResume).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', expectedSequence: 0 })
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(result.current.active?.workerState).toBe('stopped')
  unmount()
})

test('a terminal checkpoint keeps observation until the actual worker releases its lease', async () => {
  const terminal = { ...accepted, job: { ...job, stage: 'cancelled', cancelRequested: true }, workerState: 'running', workerRunning: true }
  api.historyRead.mockResolvedValueOnce(terminal).mockResolvedValue({ ...terminal, workerState: 'stopped', workerRunning: false })
  const { result, unmount } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.open('job'))
  await waitFor(() => expect(result.current.active?.workerState).toBe('stopped'), { timeout: 2000 })
  expect(api.historyRun).not.toHaveBeenCalled()
  unmount()
})


test('an archived normalized legacy task can verify ownership without cancelling or rerunning its parser', async () => {
  const legacy = { ...accepted, job: { ...job, stage: 'normalized', archived: true }, workerState: 'unknown', workerError: 'history_job_execution_untracked' }
  api.historyRead.mockResolvedValue(legacy)
  api.historyResume.mockResolvedValue({ ...legacy, workerState: 'stopped', workerError: null, job: { ...legacy.job, sequence: 1 } })
  const { result, unmount } = renderHook(() => useMigrationHistory('target', undefined, () => true))
  await act(() => result.current.open('job'))
  await act(() => result.current.resume())
  expect(api.historyResume).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', expectedSequence: 0 })
  expect(api.historyRun).not.toHaveBeenCalled()
  expect(api.historyCancel).not.toHaveBeenCalled()
  expect(result.current.active?.job.stage).toBe('normalized')
  unmount()
})

test('a creation fixes explicit initial limits before dispatch and rejects editing the same unknown identity', async () => {
  const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 }
  api.historyCreate.mockRejectedValue(new Error('lost acknowledgement'))
  api.historyRead.mockRejectedValue(new Error('offline'))
  const { result } = renderHook(() => useMigrationHistory('target', '/owned', () => true))
  await act(() => result.current.discover())
  await act(() => result.current.importSource('selection', limits))
  const intent = api.historyCreate.mock.calls[0][0]
  expect(intent.resourceLimits).toEqual(limits)
  await act(() => result.current.importSource('selection', { ...limits, maxTotalBytes: 8388608 }))
  expect(result.current.error).toBe('migration_resource_initial_intent_changed')
  expect(api.historyCreate).toHaveBeenCalledTimes(1)
  expect(api.historyRun).not.toHaveBeenCalled()
  await act(() => result.current.importSource('selection', limits))
  expect(api.historyCreate).toHaveBeenLastCalledWith(intent)
})
