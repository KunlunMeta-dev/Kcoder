import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { ModelPolicyError, type ModelPolicyClient } from '@/kcoder/modelPolicies'
import type {
  IntegrationModelPolicyDefinition,
  IntegrationModelPolicySettingsSnapshot,
} from '../../../../shared/generated/contracts'
const field =
  'min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary focus-visible:ring-2 focus-visible:ring-focus/60'
export function PolicySettingsEditor({
  client,
  initial,
  onSaved,
}: {
  client: ModelPolicyClient
  initial: IntegrationModelPolicySettingsSnapshot
  onSaved: () => void
}) {
  const { t } = useTranslation('modelPolicies')
  const [snapshot, setSnapshot] = useState(initial)
  const [draft, setDraft] = useState(() => structuredClone(initial.policies))
  const [pendingId, setPendingId] = useState(() => client.pendingOperation())
  const [notice, setNotice] = useState<
    | 'saved'
    | 'rejected'
    | 'unknownSave'
    | 'pending'
    | 'changedAfterSave'
    | 'unavailable'
    | 'savedUnavailable'
    | 'rejectedUnavailable'
  >()
  const [busy, setBusy] = useState(false)
  const [currentUnavailable, setCurrentUnavailable] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const saving = useRef(false)
  useEffect(() => () => pending.current?.abort(), [])
  const valid =
    draft.length <= 32 &&
    new Set(draft.map(policy => policy.id)).size === draft.length &&
    draft.every(
      policy =>
        policy.title.trim().length > 0 &&
        policy.title.length <= 256 &&
        policy.candidates.length > 0 &&
        policy.candidates.length <= 16 &&
        new Set(
          policy.candidates.map(candidate => JSON.stringify([candidate.provider, candidate.model]))
        ).size === policy.candidates.length &&
        policy.candidates.every(candidate => candidate.provider && candidate.model)
    )
  const edit = (
    index: number,
    change: (policy: IntegrationModelPolicyDefinition) => IntegrationModelPolicyDefinition
  ) => setDraft(draft.map((policy, at) => (at === index ? change(policy) : policy)))
  const move = (pool: number, from: number, to: number) =>
    edit(pool, policy => {
      const candidates = [...policy.candidates]
      const [item] = candidates.splice(from, 1)
      candidates.splice(to, 0, item)
      return { ...policy, candidates }
    })
  const save = async () => {
    if (saving.current || busy || pendingId || !valid || !client.isCurrent()) return
    saving.current = true
    setBusy(true)
    setNotice(undefined)
    const abort = new AbortController()
    pending.current = abort
    const operationId = `model-policy-save-${crypto.randomUUID()}`
    setPendingId(operationId)
    try {
      const result = await client.save(
        structuredClone(draft),
        snapshot.revision,
        operationId,
        abort.signal
      )
      if (abort.signal.aborted || !client.isCurrent()) return
      setSnapshot(result.current)
      if (result.operation.phase === 'completed') {
        setDraft(structuredClone(result.current.policies))
        setPendingId(null)
        setNotice(
          result.operation.entityRef?.revision === result.current.revision
            ? 'saved'
            : 'changedAfterSave'
        )
        onSaved()
      } else if (result.operation.phase === 'rejected' || result.operation.phase === 'cancelled') {
        setPendingId(null)
        setNotice('rejected')
      } else setNotice('unknownSave')
    } catch (error) {
      if (!abort.signal.aborted) {
        if (error instanceof ModelPolicyError && error.code === 'unsupported') {
          client.forgetPendingOperation()
          setPendingId(null)
          setNotice('unavailable')
        } else setNotice('unknownSave')
      }
    } finally {
      saving.current = false
      if (pending.current === abort) {
        pending.current = null
        setBusy(false)
      }
    }
  }
  const reconcile = async () => {
    if (!pendingId || busy || !client.isCurrent()) return
    const abort = new AbortController()
    pending.current = abort
    setBusy(true)
    try {
      const receipt = await client.operation(pendingId, abort.signal)
      let current: IntegrationModelPolicySettingsSnapshot
      try {
        current = await client.settings(abort.signal)
      } catch (error) {
        if (abort.signal.aborted || !client.isCurrent()) return
        if (receipt && ['completed', 'rejected', 'cancelled'].includes(receipt.phase)) {
          client.forgetPendingOperation()
          setPendingId(null)
          setCurrentUnavailable(true)
          setNotice(receipt.phase === 'completed' ? 'savedUnavailable' : 'rejectedUnavailable')
          return
        }
        throw error
      }
      if (abort.signal.aborted || !client.isCurrent()) return
      setSnapshot(current)
      if (receipt?.phase === 'completed') {
        setDraft(structuredClone(current.policies))
        setNotice(receipt.entityRef?.revision === current.revision ? 'saved' : 'changedAfterSave')
        client.forgetPendingOperation()
        setPendingId(null)
        onSaved()
      } else if (receipt?.phase === 'rejected' || receipt?.phase === 'cancelled') {
        setNotice('rejected')
        client.forgetPendingOperation()
        setPendingId(null)
      } else setNotice('pending')
    } catch {
      if (!abort.signal.aborted && client.isCurrent()) setNotice('unknownSave')
    } finally {
      if (pending.current === abort) {
        pending.current = null
        setBusy(false)
      }
    }
  }
  const readCurrent = async () => {
    if (busy || !client.isCurrent()) return
    const abort = new AbortController()
    pending.current = abort
    setBusy(true)
    try {
      const current = await client.settings(abort.signal)
      if (abort.signal.aborted || !client.isCurrent()) return
      setSnapshot(current)
      setDraft(structuredClone(current.policies))
      setCurrentUnavailable(false)
      setNotice(undefined)
      onSaved()
    } catch {
      /* Keep the authoritative original outcome while current configuration is unreadable. */
    } finally {
      if (pending.current === abort) {
        pending.current = null
        setBusy(false)
      }
    }
  }
  return (
    <section className="space-y-4" data-testid="model-policy-settings">
      <p className="text-sm text-text-secondary">{t('configNote')}</p>
      <fieldset disabled={busy || Boolean(pendingId) || currentUnavailable} className="space-y-5">
        {draft.map((policy, index) => (
          <div key={policy.id} className="space-y-3 border-b border-border/60 pb-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 space-y-1 text-sm">
                {t('name')}
                <input
                  className={field}
                  value={policy.title}
                  maxLength={256}
                  onChange={event =>
                    edit(index, value => ({ ...value, title: event.target.value }))
                  }
                />
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={event =>
                    edit(index, value => ({ ...value, enabled: event.target.checked }))
                  }
                />
                {t('enabled')}
              </label>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(draft.filter((_, at) => at !== index))}
              >
                {t('removePool')}
              </Button>
            </div>
            <ol className="space-y-2">
              {policy.candidates.map((candidate, at) => (
                <li
                  key={`${at}:${candidate.provider}:${candidate.model}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <label className="min-w-0 flex-1 space-y-1 text-sm">
                    {t('model')}
                    <SettingsSelect
                      className={field}
                      value={JSON.stringify([candidate.provider, candidate.model])}
                      onChange={event => {
                        const model = snapshot.models.find(
                          model =>
                            JSON.stringify([model.provider, model.model]) === event.target.value
                        )
                        if (model)
                          edit(index, policy => ({
                            ...policy,
                            candidates: policy.candidates.map((candidate, index) =>
                              index === at
                                ? { provider: model.provider, model: model.model, enabled: true }
                                : candidate
                            ),
                          }))
                      }}
                    >
                      <option value={JSON.stringify(['', ''])}>{t('chooseModel')}</option>
                      {candidate.provider &&
                        !snapshot.models.some(
                          model =>
                            model.provider === candidate.provider && model.model === candidate.model
                        ) && (
                          <option value={JSON.stringify([candidate.provider, candidate.model])}>
                            {candidate.provider} / {candidate.model}
                          </option>
                        )}
                      {snapshot.models.map(model => (
                        <option
                          key={JSON.stringify([model.provider, model.model])}
                          value={JSON.stringify([model.provider, model.model])}
                        >
                          {model.provider} / {model.model}
                          {model.available ? '' : ` · ${t('modelUnavailable')}`}
                        </option>
                      ))}
                    </SettingsSelect>
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={candidate.enabled}
                      onChange={event =>
                        edit(index, policy => ({
                          ...policy,
                          candidates: policy.candidates.map((value, candidate) =>
                            candidate === at ? { ...value, enabled: event.target.checked } : value
                          ),
                        }))
                      }
                    />
                    {t('enabled')}
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={at === 0}
                    aria-label={t('moveUp')}
                    onClick={() => move(index, at, at - 1)}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={at === policy.candidates.length - 1}
                    aria-label={t('moveDown')}
                    onClick={() => move(index, at, at + 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      edit(index, value => ({
                        ...value,
                        candidates: value.candidates.filter((_, candidate) => candidate !== at),
                      }))
                    }
                  >
                    {t('removeCandidate')}
                  </Button>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              disabled={policy.candidates.length >= 16}
              onClick={() =>
                edit(index, value => ({
                  ...value,
                  candidates: [...value.candidates, { provider: '', model: '', enabled: true }],
                }))
              }
            >
              {t('addCandidate')}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={draft.length >= 32}
          onClick={() =>
            setDraft([
              ...draft,
              { id: `personal.${crypto.randomUUID()}`, title: '', enabled: true, candidates: [] },
            ])
          }
        >
          {t('addPool')}
        </Button>
      </fieldset>
      {snapshot.modelsTruncated && (
        <p className="text-sm text-text-secondary">{t('modelsTruncated')}</p>
      )}
      {!valid && draft.length > 0 && <p className="text-sm text-text-secondary">{t('invalid')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={
            busy ||
            Boolean(pendingId) ||
            notice === 'rejected' ||
            currentUnavailable ||
            !valid ||
            JSON.stringify(draft) === JSON.stringify(snapshot.policies)
          }
          onClick={() => void save()}
        >
          {t(busy ? 'saving' : 'save')}
        </Button>
        {pendingId && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void reconcile()}>
            {t('reconcile')}
          </Button>
        )}
        {busy && (
          <Button type="button" variant="ghost" onClick={() => pending.current?.abort()}>
            {t('cancel')}
          </Button>
        )}
      </div>
      {currentUnavailable && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void readCurrent()}>
          {t('retry')}
        </Button>
      )}
      {(pendingId || notice) && (
        <p role="status" className="text-sm text-text-secondary">
          {t(notice ?? 'unknownSave')}
        </p>
      )}
      {!busy && ((pendingId && notice === 'pending') || notice === 'rejected') && (
        <details>
          <summary className="cursor-pointer text-sm text-text-secondary">
            {t('adoptCurrent')}
          </summary>
          <p className="py-2 text-sm text-text-secondary">{t('adoptNote')}</p>
          <ul className="space-y-1 pb-3 text-sm text-text-secondary">
            {snapshot.policies.map(policy => (
              <li key={policy.id}>
                {policy.title || policy.id}:{' '}
                {policy.candidates
                  .map(candidate => `${candidate.provider} / ${candidate.model}`)
                  .join('; ')}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(structuredClone(snapshot.policies))
              client.forgetPendingOperation()
              setPendingId(null)
              setNotice(undefined)
              onSaved()
            }}
          >
            {t('adoptCurrent')}
          </Button>
        </details>
      )}
    </section>
  )
}
