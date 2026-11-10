import { describe, expect, it } from 'vitest'
import { validMigrationSourceObservation } from '../../../shared/migrationSourceObservation'

const id='22222222-2222-4222-8222-222222222222'
const unknown={requestId:id,coordinatorState:'unknown',observation:'unobserved',result:null,progress:null,errorCode:null}
const control={sequence:1,cancelWatermark:0,cancelled:false,ready:true}
const receipt={requestId:id,manifestSha256:'a'.repeat(64),entries:1,bytes:10}
const ready={...unknown,observation:'observed',result:{requestId:id,phase:'ready',sourceState:control,targetState:control,
  receipt,sourceCapture:{status:'ready',errorCode:null},sourceSnapshotControl:null,targetWorkerRunning:false,targetAdmissionControl:null}}

describe('transfer observation semantics',()=>{
  it('keeps unknown acceptance separate from an authoritative receipt',()=>{
    expect(validMigrationSourceObservation(unknown,id)).toBe(true)
    expect(validMigrationSourceObservation(ready,id)).toBe(true)
    expect(validMigrationSourceObservation({...unknown,observation:'observed'},id)).toBe(false)
    expect(validMigrationSourceObservation({...ready,result:{...ready.result,receipt:null}},id)).toBe(false)
  })
  it('rejects cross-operation receipts and mismatched Native ready state',()=>{
    expect(validMigrationSourceObservation({...ready,result:{...ready.result,receipt:{...receipt,requestId:'other'}}},id)).toBe(false)
    expect(validMigrationSourceObservation({...ready,result:{...ready.result,targetState:{...control,ready:false}}},id)).toBe(false)
  })
  it('does not infer completion from an idle coordinator',()=>{
    expect(validMigrationSourceObservation({...unknown,coordinatorState:'idle'},id)).toBe(true)
  })
  it('target-only observations cannot claim a live source or incomplete bytes as Ready',()=>{
    const result={requestId:id,scope:'target',sourceObserved:false,phase:'ready',sourceState:null,sourceCapture:null,
      sourceSnapshotControl:null,targetState:control,targetAdmissionControl:null,targetWorkerRunning:false,receipt,
      progress:{manifestSha256:receipt.manifestSha256,entries:1,totalBytes:10,acceptedBytes:10,partsComplete:true}}
    expect(validMigrationSourceObservation({...ready,result},id)).toBe(true)
    expect(validMigrationSourceObservation({...ready,result:{...result,sourceObserved:true}},id)).toBe(false)
    expect(validMigrationSourceObservation({...ready,result:{...result,progress:{...result.progress,acceptedBytes:9}}},id)).toBe(false)
  })
  it('bounds counts and never accepts raw error messages',()=>{
    expect(validMigrationSourceObservation({...ready,errorCode:'secret filesystem path'},id)).toBe(false)
    expect(validMigrationSourceObservation({...ready,result:{...ready.result,receipt:{...receipt,bytes:2**32}}},id)).toBe(false)
    expect(validMigrationSourceObservation({...unknown,progress:{requestId:id,phase:'transferring',entries:1,totalBytes:1,acceptedBytes:2}},id)).toBe(false)
  })
})
