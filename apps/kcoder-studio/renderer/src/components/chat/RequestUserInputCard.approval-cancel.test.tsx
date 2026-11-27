import '@/i18n'
import i18n from '@/i18n'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

afterEach(cleanup)

test.each(['zh-CN', 'en'])('a cancel-only approval is localized without changing its submitted value (%s)', async locale => {
  const previous = i18n.language
  await i18n.changeLanguage(locale)
  try {
    const onSubmit = vi.fn()
    render(<RequestUserInputCard payload={{
      kind: 'request_user_input', requestId: 101, itemId: 'approval',
      approvalPresentation: { kind: 'command', subject: 'echo controlled', input: null, reason: null },
      questions: [{ id: 'approval', header: 'Permission request', question: 'Run command?', isOther: false,
        options: [{ label: 'Cancel', description: 'Cancel this approval request.' }] }],
    }} onSubmit={onSubmit} />)
    const option = screen.getByTestId('request-user-input-option-approval-0')
    expect(option).toHaveTextContent(i18n.t('approvalUi.cancel'))
    expect(option).toHaveTextContent(i18n.t('approvalUi.cancelDescription'))
    fireEvent.click(option)
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      requestId: 101, itemId: 'approval', answers: { approval: { answers: ['Cancel'] } },
    })
  } finally {
    await i18n.changeLanguage(previous)
  }
})
