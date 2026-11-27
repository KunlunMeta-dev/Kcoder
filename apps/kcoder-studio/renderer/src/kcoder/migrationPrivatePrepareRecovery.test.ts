import { expect, it } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source-credentials.json'
import { privatePrepareRecovery } from '../../../shared/migrationPrivatePrepareRecovery'
import type { MigrationSourceCredentialPrepareParams } from '../../../shared/generated/contracts'
const base = examples.MigrationSourceCredentialPrepareParams[0].value as MigrationSourceCredentialPrepareParams
it('keeps distinct tab offer sets immutable and finds the original sequence after plan replacement', () => {
  localStorage.clear()
  const a = privatePrepareRecovery(localStorage, 'owned', base.jobId)
  const b = privatePrepareRecovery(localStorage, 'owned', base.jobId)
  a.save('old-plan', base)
  const other = { ...base, locator: { ...base.locator, offerId: '22222222-2222-4222-8222-222222222222' } }
  b.save('old-plan', other)
  expect(a.list()).toHaveLength(2)
  expect(b.find({ ...base, expectedSequence: base.expectedSequence + 2 })).toEqual({ version: 2, planId: 'old-plan', input: base })
  expect(() => b.save('new-plan', { ...base, expectedSequence: base.expectedSequence + 2 })).toThrow()
  expect(a.find(base)?.input).toEqual(base)
})
it('reads the prior fixed-plan format without overwriting its pending original intent', () => {
  localStorage.clear()
  const key = `kcoder.mobile.private-prepare:owned:${base.jobId}:old-plan`, raw = JSON.stringify(base)
  localStorage.setItem(key, raw)
  const store = privatePrepareRecovery(localStorage, 'owned', base.jobId)
  expect(store.find(base)?.planId).toBe('old-plan')
  store.save('new-plan', base)
  expect(localStorage.length).toBe(1)
  expect(localStorage.getItem(key)).toBe(raw)
})
it('does not mix account scopes or accept a corrupted original record', () => {
  localStorage.clear()
  const a = privatePrepareRecovery(localStorage, 'a', base.jobId)
  a.save('saved-plan', base)
  expect(privatePrepareRecovery(localStorage, 'b', base.jobId).find(base)).toBeNull()
  localStorage.setItem(localStorage.key(0)!, '{}')
  expect(() => a.list()).toThrow()
})
