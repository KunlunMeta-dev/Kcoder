import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationAuthorization } from './ApplicationAuthorization'
import { ResourcePicker } from './ResourcePicker'
import { ConnectivityClient } from './client'
import type { ConnectionView, ConnectivityReply, ConnectivityRequest, ConnectivityScope } from './types'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN' } }) }))
const scope: ConnectivityScope = { accountId: 'owner', targetId: 'target', workspaceId: null, identityGeneration: '1', targetRevision: '1' }
const connection: ConnectionView = { id: 'connection', revision: '1', kind: 'agent_mail', label: '隔离测试连接', enabled: false, hasCredential: false, state: 'configured', configuration: {}, resourceGrants: [] }
function reply<T>(request: ConnectivityRequest, result: T): ConnectivityReply<T> { return { contractVersion: 'parallel-v1', requestId: request.requestId, operationId: request.operationId ?? null, status: 'completed', result, error: null, entityRevision: null, observedAt: '2026-10-24T00:00:00Z' } }
describe('connection authorization and resource panels', () => {
  it('cancels the original in-flight OAuth operation and ignores its late URL', async () => {
    const calls: ConnectivityRequest[] = []
    let finish!: (value: ConnectivityReply<unknown>) => void
    let original!: ConnectivityRequest
    const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => {
      calls.push(request)
      if (request.payload.action === 'authorize') { original = request; return await new Promise(resolve => { finish = resolve as typeof finish }) as ConnectivityReply<T> }
      return reply(request, { state: 'cancelled' }) as ConnectivityReply<T>
    })
    const close = vi.fn()
    render(<ApplicationAuthorization client={client} connection={connection} onChanged={vi.fn()} onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: '开始浏览器授权' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: '取消授权' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(calls.find(value => value.payload.action === 'cancelAuthorization')?.payload.authorizationOperationId).toBe(original.operationId)
    await act(async () => { finish(reply(original, { authorizationId: 'auth', authorizationUrl: 'https://not-live.example.invalid/authorize', state: 'waiting', expiresAt: '2026-10-24T10:00:00Z' })) })
    expect(screen.queryByRole('link', { name: '在浏览器授权' })).not.toBeInTheDocument()
  })
  it('saves only selected current resource references and preserves their revisions', async () => {
    const calls: ConnectivityRequest[] = []
    const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => { calls.push(request); return reply(request, request.payload.discover ? { items: [{ id: 'native-candidate', revision: '7', kind: 'document', label: '年度工作材料' }], nextCursor: null, resourceGrants: [] } : { revision: '2' }) as ConnectivityReply<T> })
    const changed = vi.fn()
    render(<ResourcePicker client={client} connection={connection} scopeRevision="1" onChanged={changed} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: '年度工作材料' }))
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    const save = calls.find(value => value.payload.action === 'setResources')
    expect(save?.expectedRevision).toBe('1')
    expect(save?.payload.resourceGrants).toEqual([{ id: 'native-candidate', revision: '7', kind: 'document' }])
  })
})
