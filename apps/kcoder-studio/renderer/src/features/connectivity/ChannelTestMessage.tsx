import { useEffect, useMemo, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import type { ConnectivityClient } from './client'
import type { ConnectionView } from './types'

interface Candidate { id: string; revision: string; externalSubjectId: string; conversationId: string; subscriptionAvailable: boolean }
interface Pending { operationId: string; candidateRef: { id: string; revision: string }; connectionRevision: string; locale: 'zh-CN' | 'en' }
interface Delivery { deliveryId: string | null; deliveryState: string; observed?: boolean }
interface Page { testMessageSupported?: boolean; destinationCandidates?: Candidate[]; destinationCandidateNextCursor?: string | null; testMessageOperation?: Delivery }

function restore(key: string): Pending | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Pending> | null
    if (value && typeof value.operationId === 'string' && typeof value.connectionRevision === 'string'
      && typeof value.candidateRef?.id === 'string' && typeof value.candidateRef.revision === 'string'
      && (value.locale === 'zh-CN' || value.locale === 'en')) return value as Pending
  } catch { /* A client cache is never execution authority. */ }
}

/** One reviewed destination and one fixed message; unknown results only read the original operation. */
interface Props {
  client: ConnectivityClient; connection: ConnectionView; scopeRevision: string
}
export function ChannelTestMessage(props: Props) {
  const owner = useMemo(() => ({ client: props.client, generation: createRandomUuid() }), [props.client])
  return <OwnedTestMessage key={JSON.stringify([owner.generation, owner.client.scopeIdentity(), props.connection.id,
    props.connection.revision, props.scopeRevision])} {...props} client={owner.client} />
}
function OwnedTestMessage({ client, connection }: Props) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const cacheKey = JSON.stringify(['kcoder-channel-test-v1', client.scopeIdentity(), connection.id])
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [page, setPage] = useState<Page>()
  const [candidate, setCandidate] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState<Pending | undefined>(() => restore(cacheKey)), [result, setResult] = useState<Delivery>(), [error, setError] = useState('')
  const owner = useRef({ generation: 0, scope: client.scopeIdentity() }), activeRead = useRef<AbortController | null>(null)
  const current = (generation: number) => generation === owner.current.generation
  useEffect(() => {
    const lifetime = owner, reads = activeRead
    return () => { lifetime.current.generation++; reads.current?.abort() }
  }, [])
  const observe = async (original = pending, after = '') => {
    const generation = ++owner.current.generation, cancel = new AbortController()
    activeRead.current?.abort(); activeRead.current = cancel; setBusy(true); setError('')
    try {
      const value = await client.call<Page>('P-CONNECTION', 'readResourceGrant', {
        connectionId: connection.id, ...(after ? { destinationCandidateAfter: after } : {}),
        ...(original ? { testMessageOperation: original } : {}),
      }, { expectedScopeKey: owner.current.scope, signal: cancel.signal })
      if (!current(generation)) return
      setPage(value); setCandidate(''); setConfirmed(false)
      if (original && value.testMessageOperation?.observed) {
        setResult(value.testMessageOperation)
        if (['accepted', 'failed', 'blocked', 'cancelled', 'rejected'].includes(value.testMessageOperation.deliveryState)) {
          sessionStorage.removeItem(cacheKey); setPending(undefined)
        }
      }
    } catch { if (current(generation)) setError(zh ? '暂时无法核对原连接，请重试读取。' : 'Unable to inspect this connection. Retry the read.') }
    finally { if (current(generation)) setBusy(false) }
  }
  const close = () => { owner.current.generation++; activeRead.current?.abort(); setOpen(false); setBusy(false) }
  const send = async () => {
    const selected = page?.destinationCandidates?.find(value => value.id === candidate)
    if (busy || pending || !confirmed || !page?.testMessageSupported || !selected?.subscriptionAvailable) return
    const original: Pending = { operationId: createRandomUuid(), candidateRef: { id: selected.id, revision: selected.revision },
      connectionRevision: connection.revision, locale: zh ? 'zh-CN' : 'en' }
    const generation = owner.current.generation
    setBusy(true); setError(''); setConfirmed(false)
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify(original)); setPending(original)
      const delivery = await client.call<Delivery>('P-CONNECTION', 'prepareConnectionAction', {
        action: 'testMessage', connectionId: connection.id, destinationCandidateRef: original.candidateRef,
        explicitConfirmation: true, locale: original.locale,
      }, { operationId: original.operationId, expectedRevision: original.connectionRevision, expectedScopeKey: owner.current.scope })
      if (!current(generation)) return
      setResult(delivery)
      if (['accepted', 'failed', 'blocked', 'cancelled', 'rejected'].includes(delivery.deliveryState)) {
        sessionStorage.removeItem(cacheKey); setPending(undefined)
      }
    } catch { if (current(generation)) setError(zh ? '发送结果需要核对，请读取原操作；不会自动重发。' : 'Inspect the original operation to confirm the result. No automatic resend.') }
    finally { if (current(generation)) setBusy(false) }
  }
  const status = result?.deliveryState === 'accepted' ? zh ? '平台已受理测试消息，未确认对方已读。' : 'The platform accepted the test message; read status is unknown.'
    : result ? zh ? '测试消息尚未确认成功，可核对原投递结果。' : 'Test delivery is unconfirmed. Inspect the original result.' : ''
  return <>
    <Button type="button" variant="outline" onClick={() => { setOpen(true); void observe() }}>
      {zh ? '发送测试消息' : 'Send test message'}
    </Button>
    {open && <ModalDialog title={zh ? '确认测试消息' : 'Confirm test message'} onClose={close} closeLabel={zh ? '关闭' : 'Close'} testId="channel-test-message">
      <div className="grid gap-4 pt-4">
        <p className="text-sm text-text-secondary">{connection.label}</p>
        {!page?.testMessageSupported && !busy && <p role="status" className="text-sm text-text-secondary">{zh ? '当前目标尚未声明测试消息支持，请更新目标后再试。' : 'This target has not declared test-message support. Update the target to continue.'}</p>}
        <SettingsSelect icon={<MapPin aria-hidden="true" />} aria-label={zh ? '测试消息目的地' : 'Test destination'} value={candidate}
          disabled={busy || !!pending || !page?.testMessageSupported} onChange={event => { setCandidate(event.target.value); setConfirmed(false) }}>
          <option value="">{zh ? '明确选择一个已观察的会话' : 'Select one observed conversation'}</option>
          {page?.destinationCandidates?.map(value => <option key={`${value.id}:${value.revision}`} value={value.id} disabled={!value.subscriptionAvailable}>
            {value.conversationId} · {value.externalSubjectId}{!value.subscriptionAvailable ? zh ? '（当前平台不支持主动测试）' : ' (proactive test unavailable)' : ''}
          </option>)}
        </SettingsSelect>
        <p className="rounded-md bg-surface p-3 text-sm">{zh ? 'KCoder Studio 连接测试消息。' : 'KCoder Studio connection test message.'}</p>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmed} disabled={busy || !!pending || !candidate}
          onChange={event => setConfirmed(event.target.checked)} />{zh ? '确认仅向所选会话发送这一条测试消息' : 'Send this one test message only to the selected conversation'}</label>
        {error && <p role="status" className="text-sm text-text-secondary">{error}</p>}
        {status && <p role="status" className="text-sm text-text-secondary">{status}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {page?.destinationCandidateNextCursor && !pending && <Button type="button" variant="outline" disabled={busy} onClick={() => void observe(undefined, page.destinationCandidateNextCursor ?? '')}>{zh ? '更多会话' : 'More conversations'}</Button>}
          <Button type="button" variant="outline" disabled={busy} onClick={() => void observe()}>{pending ? zh ? '核对原测试结果' : 'Inspect original test' : zh ? '刷新' : 'Refresh'}</Button>
          <Button type="button" disabled={busy || !!pending || !confirmed || !candidate || !page?.testMessageSupported} onClick={() => void send()}>{zh ? '确认发送一次' : 'Send once'}</Button>
        </div>
      </div>
    </ModalDialog>}
  </>
}
