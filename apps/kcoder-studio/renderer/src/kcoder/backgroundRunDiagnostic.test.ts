import { describe, expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { reportBackgroundRunDiagnostic } from './backgroundRunDiagnostic'
const threadId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
describe('accepted background diagnostic lifecycle', () => {
  test.each(['extracted', 'installed'])('%s correlates one run after parent completion without duplicate or raw payload logging', async kind => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const client = Object.assign(new FakeGatewayClient(threadId), { diagnosticConnection: Object.freeze({targetId:'local',connectionId:'rpc-7-1'}) })
    const options = {loadServers:async()=>[{id:'local',label:'Local',description:'Local',transport:'local' as const,workspacePath:'/workspace'}],createClient:()=>client}
    const runtime = kind === 'extracted' ? createTestGatewayRuntime('token',options) : new InstalledRuntime('token',options)
    const rows = () => log.mock.calls.filter(row=>row[0]==='[kcoder-background-run]').map(row=>row[1])
    try {
      await runtime.request('runtime.tasks.create',{taskId:'diagnostic-task',executionRequest:{prompt:'private prompt'}})
      client.emitNotification('turn/started',{threadId,turn:{id:'turn-1'},attemptId:'turn-1'})
      const frame = (type:string, sequence:number) => ({threadId,turnId:'turn-1',identity:{run:{parentSessionId:threadId,agentId:'worker',runId},eventId:`${runId}:${sequence}`,runSequence:sequence},headers:{Authorization:'PRIVATE_SECRET'},event:{type,id:'worker',tool_call_id:'call-worker',text:'PRIVATE_SECRET',error:'PRIVATE_SECRET',reason:'PRIVATE_SECRET',tool_input:{secret:'PRIVATE_SECRET'}}})
      client.emitNotification('item/event',frame('background_job_associated',1))
      client.diagnosticConnection = Object.freeze({targetId:'local',connectionId:'rpc-7-2'})
      await expect.poll(()=>rows().length).toBe(1)
      client.emitNotification('turn/completed',{threadId,turn:{id:'turn-1',status:'completed'},attemptId:'turn-1'})
      const terminal = frame('background_job_failed',Number.MAX_SAFE_INTEGER)
      client.emitNotification('item/event',terminal)
      client.emitNotification('item/event',terminal)
      await expect.poll(()=>rows().length).toBe(2)
      await new Promise(resolve=>setTimeout(resolve,0))
      expect(rows()).toHaveLength(2)
      expect(rows().map(row=>row.code)).toEqual(['background_run_running','background_run_failed'])
      for (const row of rows()) expect(row).toMatchObject({targetId:'local',threadId,runId,attemptId:'turn-1',attemptScope:'parent_turn'})
      expect(rows().map(row=>row.connectionId)).toEqual(['rpc-7-1','rpc-7-2'])
      expect(JSON.stringify(rows())).not.toContain('PRIVATE_SECRET')
    } finally { runtime.dispose(); log.mockRestore() }
  })
  test('core process-scoped session IDs are retained',()=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{})
    const session='0'.repeat(32)+'-'+'a'.repeat(8)+'-'+'1'.repeat(16)
    try {
      reportBackgroundRunDiagnostic({connection:{targetId:'remote.a',connectionId:'rpc-1-2'},threadId:session,runId,attemptId:'turn-1',status:'completed'})
      expect(log.mock.calls[0][1]).toMatchObject({threadId:session,targetId:'remote.a'})
      reportBackgroundRunDiagnostic({connection:{targetId:'local',connectionId:'rpc-1-2'},threadId:'Ab123',runId,attemptId:'turn-1',status:'completed'})
      expect(log.mock.calls[1][1]).toMatchObject({threadId:'Ab123'})
    } finally { log.mockRestore() }
  })
  test('malformed correlation values are not echoed as diagnostics',()=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{})
    try {
      reportBackgroundRunDiagnostic({connection:{targetId:'local',connectionId:'rpc-1-1'},threadId:'PRIVATE_SECRET',runId,attemptId:'PRIVATE_SECRET',status:'failed'})
      expect(log.mock.calls[0][1]).toMatchObject({threadId:null,attemptId:null})
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_SECRET')
    } finally { log.mockRestore() }
  })
})
