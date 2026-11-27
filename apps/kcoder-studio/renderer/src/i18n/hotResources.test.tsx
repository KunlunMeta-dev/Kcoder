import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { createInstance, type Resource } from 'i18next'
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next'
import { replaceLocaleResources } from './hotResources'

afterEach(cleanup)

test('locale replacement updates mounted translations while preserving language, focus and draft state', async () => {
  const instance = createInstance()
  const resources: Resource = {
    en: { common: { label: 'Before', removed: 'Old label' } },
    'zh-CN': { common: { label: '之前' } },
  }
  await instance.use(initReactI18next).init({
    lng: 'en',
    resources: structuredClone(resources),
    defaultNS: 'common',
    react: { bindI18n: 'languageChanged loaded' },
  })
  instance.addResourceBundle('en', 'runtimeExtension', { label: 'Keep plugin data' })
  function Editor() {
    const { t } = useTranslation()
    const [draft, setDraft] = useState('')
    return (
      <>
        <span>{t('label')}</span>
        <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
      </>
    )
  }
  render(
    <I18nextProvider i18n={instance}>
      <Editor />
    </I18nextProvider>
  )
  const input = screen.getByLabelText('draft')
  fireEvent.change(input, { target: { value: 'Unsent work' } })
  input.focus()
  act(() =>
    replaceLocaleResources(instance, resources, {
      en: { common: { label: 'After' } },
      'zh-CN': { common: { label: '之后' } },
    })
  )
  expect(screen.getByText('After')).toBeTruthy()
  expect(screen.getByLabelText('draft')).toBe(input)
  expect(input).toHaveValue('Unsent work')
  expect(input).toHaveFocus()
  expect(instance.language).toBe('en')
  expect(instance.exists('removed')).toBe(false)
  expect(instance.getResource('en', 'runtimeExtension', 'label')).toBe('Keep plugin data')
  expect(instance.getFixedT('zh-CN')('label')).toBe('之后')
})
