import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import {
  createRuntimeTargetSession,
  updateRuntimeTargetSession,
  type RuntimeTargetEditorSession,
  type RuntimeTargetErrors,
} from '../runtime-target-model'
import { RuntimeTargetEditor } from '../RuntimeTargetEditor'

// Controlled-editor contract tests: rendering, validation display, and the
// advanced-settings header. The redesign keeps every data-testid stable.
const t = i18n.getFixedT(null, 'localRuntime')

function makeSession(overrides: Partial<RuntimeTargetEditorSession> = {}) {
  return { ...createRuntimeTargetSession(), ...overrides }
}

function editorProps(
  overrides: Partial<Parameters<typeof RuntimeTargetEditor>[0]> = {}
): Parameters<typeof RuntimeTargetEditor>[0] {
  return {
    session: makeSession(),
    errors: {} as RuntimeTargetErrors,
    busy: null,
    result: null,
    t,
    onUpdate: vi.fn(),
    onBlur: vi.fn(),
    onToggleAdvanced: vi.fn(),
    onClose: vi.fn(),
    onTest: vi.fn(),
    onSubmit: vi.fn(),
    onRequestNoSandbox: vi.fn(),
    ...overrides,
  }
}

describe('RuntimeTargetEditor', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  test('shows the advanced settings subtitle for environment configuration options', () => {
    render(<RuntimeTargetEditor {...editorProps()} />)
    expect(screen.getByTestId('runtime-target-advanced-toggle')).toBeInTheDocument()
    expect(screen.getByText('SSH、启动命令及环境配置等选项。')).toBeInTheDocument()
  })

  test('renders identity fields and advanced settings for SSH targets', () => {
    render(
      <RuntimeTargetEditor {...editorProps({ session: makeSession({ advancedOpen: true }) })} />
    )
    for (const testId of [
      'runtime-target-form',
      'runtime-target-label',
      'runtime-target-id',
      'runtime-target-transport',
      'runtime-target-host',
      'runtime-target-workspace',
      'runtime-target-account-mode',
      'runtime-target-user',
      'runtime-target-port',
      'runtime-target-command',
      'runtime-target-profile',
      'runtime-target-settings-file',
      'runtime-target-chromium',
      'runtime-target-accept-host-key',
      'runtime-target-no-sandbox',
      'runtime-target-test',
      'runtime-target-save',
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
  })

  test('shows localized field errors with invalid semantics next to the field', () => {
    render(
      <RuntimeTargetEditor
        {...editorProps({
          session: makeSession({ advancedOpen: true }),
          errors: { port: 'invalidPort' } as RuntimeTargetErrors,
        })}
      />
    )
    expect(screen.getByText('端口必须是 1 到 65535 之间的整数')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-target-port')).toHaveAttribute('aria-invalid', 'true')
  })

  test('locks advanced connection fields while requiring an KCoder account', () => {
    const session = updateRuntimeTargetSession(
      makeSession({ advancedOpen: true }),
      'accountMode',
      true
    )
    render(<RuntimeTargetEditor {...editorProps({ session })} />)
    expect(screen.getByTestId('runtime-target-account-mode')).toBeChecked()
    expect(screen.getByTestId('runtime-target-command')).toBeDisabled()
    expect(screen.getByTestId('runtime-target-profile')).toBeDisabled()
    expect(screen.getByTestId('runtime-target-chromium')).toBeDisabled()
  })

  test('renders connection results with alert or status semantics', () => {
    render(
      <RuntimeTargetEditor
        {...editorProps({ result: { kind: 'error', message: '连接测试失败', detail: '超时' } })}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('连接测试失败')
    expect(screen.getByRole('alert')).toHaveTextContent('超时')
  })
})
