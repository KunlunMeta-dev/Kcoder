import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach,expect,test,vi} from 'vitest'
import '@/i18n'
import {TaskFeedbackDialog} from '@/features/feedback/TaskFeedbackDialog'
import {ScrollableMessageArea} from '../ScrollableMessageArea'
const {read}=vi.hoisted(()=>({read:vi.fn().mockResolvedValue({source:null})}))
vi.mock('@/lib/runtime-commands',()=>({invoke:vi.fn(),isGateway:()=>false}))
vi.mock('@/kcoder/gatewayMigration',()=>({createMigrationApi:()=>({continuationSource:read})}))
beforeEach(()=>{read.mockReset();read.mockResolvedValue({source:null})})

test('a tool-catalog parent does not authorize showing its history inside a child conversation',async()=>{
 const props={messages:[],toolsCatalogServerId:'target',toolsCatalogTaskId:'kcoder:target:Ab123'}
 const view=render(<ScrollableMessageArea {...props}/>)
 expect(read).not.toHaveBeenCalled()
 view.rerender(<ScrollableMessageArea {...props} importedHistoryTaskId="kcoder:target:Cd456"/>)
 await waitFor(()=>expect(read).toHaveBeenCalledExactlyOnceWith({threadId:'Cd456'},{signal:expect.any(AbortSignal)}))
})

test('background history failure stays out of the conversation and retries from current feedback only',async()=>{
 read.mockRejectedValue(new Error('historical_seed_receipt_changed /private/token'))
 const user=userEvent.setup()
 const props={messages:[{id:'message',role:'user' as const,content:'Keep this conversation visible',status:'done' as const,createdAt:'2026-10-20T09:54:00.000Z'}],toolsCatalogServerId:'target',importedHistoryTaskId:'kcoder:target:Ab123'}
 const target={deviceId:'target',taskId:props.importedHistoryTaskId}
 const view=render(<><ScrollableMessageArea {...props}/><TaskFeedbackDialog open target={target} getTaskContext={async()=>({})} onClose={()=>{}}/></>)
 const issue=await screen.findByTestId('feedback-background-issue')
 expect(issue).toHaveTextContent('暂时无法检查迁入历史，请重试。')
 expect(screen.queryByRole('alert')).not.toBeInTheDocument()
 expect(screen.getAllByText('暂时无法检查迁入历史，请重试。')).toHaveLength(1)
 expect(screen.getByText('Keep this conversation visible')).toBeInTheDocument()
 read.mockResolvedValue({source:null})
 fireEvent.click(screen.getByRole('button',{name:'重试'}))
 await waitFor(()=>expect(read).toHaveBeenCalledTimes(2))
 await waitFor(()=>expect(screen.queryByTestId('feedback-background-issue')).not.toBeInTheDocument())
 read.mockRejectedValue(new Error('historical_seed_receipt_changed'))
 view.rerender(<><ScrollableMessageArea {...props} importedHistoryTaskId="kcoder:target:Cd456"/><TaskFeedbackDialog open target={{...target,taskId:'kcoder:target:Cd456'}} getTaskContext={async()=>({})} onClose={()=>{}}/></>)
 await screen.findByTestId('feedback-background-issue')
 const close=screen.getByRole('button',{name:'关闭提示'})
 close.focus();await user.keyboard('{Enter}')
 await waitFor(()=>expect(screen.queryByTestId('feedback-background-issue')).not.toBeInTheDocument())
 expect(read).toHaveBeenCalledTimes(3)
})
