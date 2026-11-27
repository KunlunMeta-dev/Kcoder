import { expect, it, vi } from 'vitest'
import { createMigrationSourceTransferClient } from './gatewayMigrationSourceTransfers'

const id='22222222-2222-4222-8222-222222222222'
const source={sessionId:id,purpose:'source' as const,targetId:'source'}
const target={sessionId:id,purpose:'target' as const,targetId:'target'}
const input={requestId:id,attemptId:id,source,target}
const unknown={requestId:id,coordinatorState:'unknown',observation:'unobserved',result:null,progress:null,errorCode:null}
it('preserves the original attempt on uncertain admission and sends no retry',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'))
  const client=createMigrationSourceTransferClient({captureScope:()=> 'scope',fetcher})
  await expect(client.run(input)).rejects.toMatchObject({outcomeUnknown:true})
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input)
})
it('read-only reconciliation never submits a run',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(unknown)))
  const client=createMigrationSourceTransferClient({captureScope:()=> 'scope',fetcher})
  await expect(client.read({requestId:id,source,target})).resolves.toEqual(unknown)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/read')
})
it('rejects a response belonging to a different operation',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({...unknown,requestId:'other'})))
  const client=createMigrationSourceTransferClient({captureScope:()=> 'scope',fetcher})
  await expect(client.run(input)).rejects.toMatchObject({code:'source_transfer_invalid_response',outcomeUnknown:true})
})
it('source-offline reads contain only the original target selection',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(unknown)))
  const client=createMigrationSourceTransferClient({captureScope:()=> 'scope',fetcher})
  const request={requestId:id,target:{...target,purpose:'target_recovery' as const}}
  await client.targetRead(request)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(request)
})
