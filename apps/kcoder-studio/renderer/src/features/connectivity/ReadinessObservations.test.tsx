import { afterEach, beforeAll, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import copy from '@/i18n/locales/en/connectivity.json'
import { ReadinessObservations } from './ReadinessObservations'
beforeAll(async () => { await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { connectivity: copy } } }) })
afterEach(cleanup)
it('a changed connection revision makes prior successful observations stale while retaining failed business evidence', () => {
  const report = { observedAt: new Date().toISOString(), connectionRevision: 'old', observations: [
    { level: 'L3' as const, state: 'observed' as const, reasonCode: null },
    { level: 'L6' as const, state: 'failed' as const, reasonCode: 'BUSINESS_FAILED' },
  ] }
  render(<ReadinessObservations report={report} connectionRevision="new" />)
  expect(screen.getByRole('status').textContent).toMatch(/out of date/)
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getByText(/L6: failed · BUSINESS_FAILED/)).toBeTruthy()
  expect(report.observations[0].state).toBe('observed')
})
