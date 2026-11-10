import {act,renderHook,waitFor} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {useImportedHistory} from './useImportedHistory'
import {notifyAccountContextChange} from './accountContextEvents'
const {read}=vi.hoisted(()=>({read:vi.fn()}))
vi.mock('./gatewayMigration',()=>({createMigrationApi:()=>({continuationSource:read})}))
const source={operationId:'operation',sourceJobId:'archive',viewId:'selected'}
beforeEach(()=>{vi.resetAllMocks();read.mockResolvedValue({source})})

test('native provenance uses the selected thread and performs no cached restoration',async()=>{
 const {result,unmount}=renderHook(()=>useImportedHistory('target','kcoder:target:Ab123','/owned'))
 await waitFor(()=>expect(result.current.source).toEqual(source))
 expect(read).toHaveBeenCalledExactlyOnceWith({threadId:'Ab123'},{signal:expect.any(AbortSignal)})
 unmount();read.mockClear()
 renderHook(()=>useImportedHistory('target','another-runtime:target:Ab123','/owned'))
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})
 expect(read).not.toHaveBeenCalled()
})

test('target changes and account changes cannot retain old history or accept late replies',async()=>{
 let finish!:(value:unknown)=>void
 read.mockReturnValueOnce(new Promise(resolve=>{finish=resolve})).mockResolvedValue({source:null})
 const {result,rerender}=renderHook(({id})=>useImportedHistory(id,`kcoder:${id}:Ab123`,'/owned'),{initialProps:{id:'old'}})
 await waitFor(()=>expect(read).toHaveBeenCalledOnce())
 rerender({id:'new'});await waitFor(()=>expect(read).toHaveBeenCalledTimes(2))
 await act(async()=>{finish({source});await Promise.resolve()})
 expect(result.current.source).toBeNull()
 read.mockResolvedValueOnce({source});await act(()=>result.current.refresh());await waitFor(()=>expect(result.current.source).toEqual(source))
 read.mockResolvedValue({source:null});act(()=>notifyAccountContextChange('new'))
 expect(result.current.source).toBeNull();await waitFor(()=>expect(read).toHaveBeenCalledTimes(4))
})

test('older targets stay compatible while real failures remain retryable observations',async()=>{
 read.mockRejectedValueOnce(new Error('migration_continuation_source_update_required'))
 const {result}=renderHook(()=>useImportedHistory('target','kcoder:target:Ab123'))
 await waitFor(()=>expect(read).toHaveBeenCalledOnce());await act(async()=>{await Promise.resolve()})
 expect(result.current.error).toBe('');expect(result.current.source).toBeNull()
 read.mockRejectedValueOnce(new Error('historical_seed_receipt_changed'));act(()=>result.current.refresh())
 await waitFor(()=>expect(result.current.error).toBe('historical_seed_receipt_changed'))
 read.mockResolvedValue({source});act(()=>result.current.refresh());await waitFor(()=>expect(result.current.source).toEqual(source))
 expect(read).toHaveBeenCalledTimes(3)
})

test('dismissing an observation performs no request and does not suppress later retry or thread errors',async()=>{
 read.mockRejectedValue(new Error('historical_seed_receipt_changed'))
 const {result,rerender}=renderHook(({task})=>useImportedHistory('target',task),{initialProps:{task:'kcoder:target:Ab123'}})
 await waitFor(()=>expect(result.current.error).toBe('historical_seed_receipt_changed'))
 act(()=>result.current.dismissError())
 expect(result.current.error).toBe('');expect(read).toHaveBeenCalledTimes(1)
 act(()=>result.current.refresh())
 await waitFor(()=>expect(result.current.error).toBe('historical_seed_receipt_changed'))
 act(()=>result.current.dismissError())
 rerender({task:'kcoder:target:Cd456'})
 await waitFor(()=>expect(result.current.error).toBe('historical_seed_receipt_changed'))
 expect(read).toHaveBeenCalledTimes(3)
})
