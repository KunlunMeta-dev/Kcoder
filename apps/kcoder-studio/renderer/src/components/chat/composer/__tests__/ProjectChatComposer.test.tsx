import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ProjectChatComposer } from '../ProjectChatComposer'

/** Desktop composer box: `76px` grown by 20%. */
const COMPOSER_FORM_MIN_HEIGHT_PX = 91
/** Desktop composer editor: `48px`/`112px` grown by 20%. */
const COMPOSER_INPUT_MIN_HEIGHT_PX = 58
const COMPOSER_INPUT_MAX_HEIGHT_PX = 134

function renderDesktopComposer() {
  return render(
    <ProjectChatComposer
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      disabled={false}
      placeholder="随心输入"
    />
  )
}

describe('ProjectChatComposer desktop sizing', () => {
  test('uses the 20%-taller desktop composer box', () => {
    renderDesktopComposer()

    expect(screen.getByTestId('project-chat-composer-form')).toHaveClass(
      `min-h-[${COMPOSER_FORM_MIN_HEIGHT_PX}px]`,
      'flex-col',
      'rounded-[26px]'
    )
  })

  test('uses the 20%-taller editor bounds', () => {
    renderDesktopComposer()

    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      `min-h-[${COMPOSER_INPUT_MIN_HEIGHT_PX}px]`,
      `max-h-[${COMPOSER_INPUT_MAX_HEIGHT_PX}px]`,
      'resize-none'
    )
  })

  test('keeps the editor bounds inside the composer box', () => {
    expect(COMPOSER_INPUT_MIN_HEIGHT_PX).toBeLessThan(COMPOSER_FORM_MIN_HEIGHT_PX)
    expect(COMPOSER_INPUT_MAX_HEIGHT_PX).toBeGreaterThan(COMPOSER_INPUT_MIN_HEIGHT_PX)
  })
})
