import {act,renderHook,waitFor} from '@testing-library/react'
import {expect,test,vi} from 'vitest'
import {registerBackgroundIssue,useTaskBackgroundIssues} from './backgroundIssues'
import {captureAccountContextRevision,notifyAccountContextChange} from './accountContextEvents'

test('issues isolate task/workspace and invalidation disables retained actions without clearing peers',async()=>{
 const target={deviceId:'device',taskId:'task',workspacePath:'/one'}
 const valid=captureAccountContextRevision(),retry=vi.fn(),dismiss=vi.fn()
 const dispose=registerBackgroundIssue({kind:'imported_history_check',code:'IMPORTED_HISTORY_READ_FAILED',target,isCurrent:()=>valid('device'),retry,dismiss})
 const peerDispose=registerBackgroundIssue({kind:'imported_history_check',code:'IMPORTED_HISTORY_READ_FAILED',target:{...target,deviceId:'peer'},isCurrent:()=>true,retry:vi.fn(),dismiss:vi.fn()})
 const {result,rerender}=renderHook(({scope})=>useTaskBackgroundIssues(scope),{initialProps:{scope:target}})
 try{
  expect(result.current).toHaveLength(1)
  const old=result.current[0]
  rerender({scope:{...target,workspacePath:'/two'}});expect(result.current).toHaveLength(0)
  rerender({scope:{...target,taskId:'other'}});expect(result.current).toHaveLength(0)
  rerender({scope:target});expect(result.current).toHaveLength(1)
  act(()=>notifyAccountContextChange('device'))
  await waitFor(()=>expect(result.current).toHaveLength(0))
  old.retry();old.dismiss();expect(retry).not.toHaveBeenCalled();expect(dismiss).not.toHaveBeenCalled()
  rerender({scope:{...target,deviceId:'peer'}});expect(result.current).toHaveLength(1)
  act(dispose);expect(result.current).toHaveLength(1)
 }finally{act(dispose);act(peerDispose)}
})
