import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { Box } from 'lucide-react'
import {
  IconSelect,
  InfoBox,
  InputWithIcon,
  ModelMark,
  PasswordInput,
  SectionHeader,
  StatusChip,
} from '../settings-ui'

// Primitive contract tests for the shared settings form primitives. Each test
// drives one primitive from the planned R1 Phase 0 API (red first, then green).
describe('InputWithIcon', () => {
  test('renders the icon as decoration and forwards input attributes', async () => {
    const user = userEvent.setup()
    render(
      <InputWithIcon
        icon={<Box data-testid="field-icon" />}
        data-testid="field-input"
        placeholder="例如: gpt-4o、glm-5.3"
        aria-invalid={true}
      />
    )
    expect(screen.getByTestId('field-icon').closest('span')).toHaveAttribute('aria-hidden', 'true')
    const input = screen.getByTestId('field-input')
    expect(input).toHaveAttribute('placeholder', '例如: gpt-4o、glm-5.3')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.type(input, 'abc')
    expect(input).toHaveValue('abc')
  })

  test('supports the compact text size for dense target forms', () => {
    render(<InputWithIcon icon={<Box />} data-testid="dense" textSize="sm" />)
    expect(screen.getByTestId('dense').className).toContain('text-sm')
  })

  test('forwards the input ref for auto-focus callers', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(<InputWithIcon icon={<Box />} data-testid="ref-input" ref={inputRef} />)
    expect(inputRef.current).toBe(screen.getByTestId('ref-input'))
  })
})

describe('IconSelect', () => {
  test('renders options as a decorated select and forwards attributes', async () => {
    const user = userEvent.setup()
    render(
      <IconSelect icon={<Box />} data-testid="format" aria-label="格式">
        <option value="a">A</option>
        <option value="b">B</option>
      </IconSelect>
    )
    const select = screen.getByTestId('format')
    expect(screen.getByRole('combobox', { name: '格式' })).toBe(select)
    expect(select).toHaveValue('a')
    await user.selectOptions(select, 'b')
    expect(select).toHaveValue('b')
  })
})

describe('PasswordInput', () => {
  test('toggles visibility without losing the typed value', async () => {
    const user = userEvent.setup()
    render(
      <PasswordInput
        icon={<Box />}
        data-testid="secret"
        toggleTestId="secret-toggle"
        toggleLabel="显示密码"
        hideLabel="隐藏密码"
        autoComplete="new-password"
      />
    )
    const input = screen.getByTestId('secret')
    const toggle = screen.getByTestId('secret-toggle')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autoComplete', 'new-password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('aria-label', '显示密码')
    await user.type(input, 'abc')
    await user.click(toggle)
    expect(input).toHaveAttribute('type', 'text')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('aria-label', '隐藏密码')
    expect(input).toHaveValue('abc')
    await user.click(toggle)
    expect(input).toHaveAttribute('type', 'password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(input).toHaveValue('abc')
  })
})

describe('InfoBox', () => {
  test('info wraps a decorated container with optional title', () => {
    render(
      <InfoBox icon={<Box data-testid="info-icon" />} title="密钥安全" data-testid="info-box">
        密钥留空将保留原值。
      </InfoBox>
    )
    const box = screen.getByTestId('info-box')
    expect(box).toHaveTextContent('密钥安全')
    expect(box).toHaveTextContent('密钥留空将保留原值。')
    expect(screen.getByTestId('info-icon').closest('span')).toHaveAttribute('aria-hidden', 'true')
  })

  test('hint stays plain flowing text without background', () => {
    render(
      <InfoBox variant="hint" data-testid="hint-box">
        说明文字
      </InfoBox>
    )
    const hint = screen.getByTestId('hint-box')
    expect(hint.tagName).toBe('P')
    expect(hint).toHaveTextContent('说明文字')
  })
})

describe('StatusChip', () => {
  test('exposes variants through theme classes while keeping text content', () => {
    render(
      <>
        <StatusChip variant="success" data-testid="chip-success">
          已配置密钥
        </StatusChip>
        <StatusChip variant="neutral" data-testid="chip-neutral">
          内置目标
        </StatusChip>
        <StatusChip variant="destructive" data-testid="chip-danger">
          已删除
        </StatusChip>
      </>
    )
    expect(screen.getByTestId('chip-success').className).toContain('text-green-600')
    expect(screen.getByTestId('chip-success')).toHaveTextContent('已配置密钥')
    expect(screen.getByTestId('chip-neutral').className).toContain('text-text-secondary')
    expect(screen.getByTestId('chip-danger').className).toContain('text-red-500')
  })
})

describe('SectionHeader', () => {
  test('renders icon as decoration with title heading and description', () => {
    render(
      <SectionHeader
        icon={<Box data-testid="section-icon" />}
        title="运行目标"
        description="选择运行目标。"
      />
    )
    expect(screen.getByRole('heading', { name: '运行目标' })).toBeInTheDocument()
    expect(screen.getByText('选择运行目标。')).toBeInTheDocument()
    expect(screen.getByTestId('section-icon').closest('span')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })
})

describe('ModelMark', () => {
  test('renders the first code point uppercase as decoration', () => {
    render(<ModelMark label="glm" data-testid="mark" />)
    const mark = screen.getByTestId('mark')
    expect(mark).toHaveTextContent('G')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
  })

  test('keeps CJK marks stable', () => {
    render(<ModelMark label="昆仑元" data-testid="cjk-mark" />)
    expect(screen.getByTestId('cjk-mark')).toHaveTextContent('昆')
  })
})
