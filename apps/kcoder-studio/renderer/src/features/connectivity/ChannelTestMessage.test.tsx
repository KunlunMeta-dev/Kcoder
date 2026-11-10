import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { ChannelTestMessage } from './ChannelTestMessage'
import type { ConnectivityClient } from './client'
import type { ConnectionView } from './types'

const connection = { id:'channel',revision:'7',label:'Owned bot',kind:'wecom',enabled:true,state:'connected',hasCredential:true } as ConnectionView
const page = { testMessageSupported:true,destinationCandidates:[{id:'observed-chat',revision:'3',conversationId:'group',externalSubjectId:'member',subscriptionAvailable:true}] }
beforeEach(async()=>{sessionStorage.clear();await i18n.changeLanguage('en')})
afterEach(cleanup)
function fixture(outcome='accepted') {
  const call=vi.fn(async(_port:string,method:string,payload:Record<string,unknown>)=>method==='prepareConnectionAction'
    ? {deliveryId:'original-delivery',deliveryState:outcome}
    : {...page,...(payload.testMessageOperation?{testMessageOperation:{observed:true,deliveryId:'original-delivery',deliveryState:outcome}}:{})})
  const client={scopeIdentity:()=> 'original-owner',call} as unknown as ConnectivityClient
  return {client,call}
}
async function choose() {
  fireEvent.click(screen.getByRole('button',{name:'Send test message'}))
  await screen.findByRole('option',{name:'group · member'})
  fireEvent.change(screen.getByRole('combobox',{name:'Test destination'}),{target:{value:'observed-chat'}})
}
test('one destination and explicit confirmation are required before one mutation',async()=>{
  const f=fixture();render(<ChannelTestMessage client={f.client} connection={connection} scopeRevision="1" />)
  await choose();expect(screen.getByRole('button',{name:'Send once'})).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send once'}))
  await screen.findByText('The platform accepted the test message; read status is unknown.')
  const writes=f.call.mock.calls.filter(([,method])=>method==='prepareConnectionAction')
  expect(writes).toHaveLength(1);expect(writes[0][2]).toEqual({action:'testMessage',connectionId:'channel',destinationCandidateRef:{id:'observed-chat',revision:'3'},explicitConfirmation:true,locale:'en'})
})
test('unknown survives remount and reads its original operation without sending again',async()=>{
  const f=fixture('unknown'),view=render(<ChannelTestMessage client={f.client} connection={connection} scopeRevision="1" />)
  await choose();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send once'}))
  await screen.findByRole('button',{name:'Inspect original test'})
  await waitFor(()=>expect(screen.getByRole('button',{name:'Inspect original test'})).not.toBeDisabled())
  const cached=Object.values(sessionStorage).map(value=>JSON.parse(value)).find(value=>value?.operationId)
  view.unmount();render(<ChannelTestMessage client={f.client} connection={connection} scopeRevision="1" />)
  fireEvent.click(screen.getByRole('button',{name:'Send test message'}))
  await screen.findByText('Test delivery is unconfirmed. Inspect the original result.')
  expect(screen.getByRole('button',{name:'Send once'})).toBeDisabled()
  expect(f.call.mock.calls.filter(([,method])=>method==='prepareConnectionAction')).toHaveLength(1)
  expect(f.call.mock.calls.some(([,method,payload])=>method==='readResourceGrant'&&(payload.testMessageOperation as {operationId?:string})?.operationId===cached.operationId)).toBe(true)
})
test('a target without an explicit feature observation cannot send',async()=>{
  const f=fixture();f.call.mockResolvedValue({...page,testMessageSupported:false})
  render(<ChannelTestMessage client={f.client} connection={connection} scopeRevision="1" />)
  fireEvent.click(screen.getByRole('button',{name:'Send test message'}))
  await screen.findByText('This target has not declared test-message support. Update the target to continue.')
  expect(screen.getByRole('button',{name:'Send once'})).toBeDisabled()
  expect(f.call.mock.calls.filter(([,method])=>method==='prepareConnectionAction')).toHaveLength(0)
})
test('a late former-owner read does not restore a foreign target dialog',async()=>{
  const old=fixture(),next=fixture();let release!:(value:typeof page)=>void
  old.call.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
  const view=render(<ChannelTestMessage client={old.client} connection={connection} scopeRevision="1" />)
  fireEvent.click(screen.getByRole('button',{name:'Send test message'}));await waitFor(()=>expect(old.call).toHaveBeenCalled())
  view.rerender(<ChannelTestMessage client={next.client} connection={{...connection,id:'foreign'}} scopeRevision="2" />)
  release(page);await waitFor(()=>expect(screen.queryByTestId('channel-test-message')).not.toBeInTheDocument())
  expect(next.call.mock.calls.filter(([,method])=>method==='prepareConnectionAction')).toHaveLength(0)
})
