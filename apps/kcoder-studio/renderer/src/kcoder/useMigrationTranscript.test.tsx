import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationTranscript } from './useMigrationTranscript'
const { api }=vi.hoisted(() => ({api:{transcriptPage:vi.fn(),transcriptBlocks:vi.fn(),transcriptText:vi.fn()}}))
vi.mock('./gatewayMigration',()=>({createMigrationApi:()=>api}))
const page={source:'codex',sourceSessionId:'source',title:null,project:null,items:[],totalRecords:25,nextCursor:10,normalizationComplete:true,adapterRevision:'fixed'}
beforeEach(()=>{vi.resetAllMocks();api.transcriptPage.mockResolvedValue(page)})

test('archive navigation uses native record cursors and replaces the bounded page',async()=>{
  const {result}=renderHook(()=>useMigrationTranscript('target','/owned','job',()=>true))
  await waitFor(()=>expect(result.current.busy).toBe(false))
  await waitFor(()=>expect(result.current.page).toEqual(page))
  api.transcriptPage.mockResolvedValue({...page,nextCursor:20})
  await act(()=>result.current.next!())
  expect(api.transcriptPage).toHaveBeenLastCalledWith({jobId:'job',cursor:10},expect.objectContaining({signal:expect.any(AbortSignal)}))
  expect(result.current.cursor).toBe(10)
  await act(()=>result.current.previous!())
  expect(result.current.cursor).toBe(0)
})

test('leaving an archive aborts its read and late target results do not populate another view',async()=>{
  let finish!:(value:unknown)=>void
  let current=true
  api.transcriptPage.mockReturnValue(new Promise(resolve=>{finish=resolve}))
  const {result,unmount}=renderHook(()=>useMigrationTranscript('target','/owned','job',()=>current))
  await waitFor(()=>expect(api.transcriptPage).toHaveBeenCalledOnce())
  const signal=api.transcriptPage.mock.calls[0][1].signal as AbortSignal
  current=false
  await act(async()=>{finish(page);await Promise.resolve()})
  expect(result.current.page).toBeNull()
  unmount()
  expect(signal.aborted).toBe(true)
})
