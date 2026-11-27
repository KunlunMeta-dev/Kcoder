import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ModelConfigurationDetails } from './ModelConfigurationDetails'
import {
  readModelConfiguration,
  readReasoningPolicy,
} from '../../../../../shared/modelConfiguration'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const summary = {
  providerId: 'p',
  modelId: 'm',
  apiFormat: 'anthropic_messages',
  chatProtocol: 'auto',
  contextWindowTokens: 64000,
  maxOutputTokens: 2048,
  outputHeadroomTokens: 2048,
  text: true,
  tools: true,
  vision: false,
  reasoning: true,
  structuredOutput: false,
  reasoningEffort: 'high',
  extraBodyConfigured: true,
  requestOverrideFields: ['thinking'],
  revision: 'a'.repeat(64),
  boundary: 'next_turn',
  sources: { max_output_tokens: ['cli_environment'] },
}
test('retains only public metadata and predefined provenance', () => {
  const parsed = readModelConfiguration({
    ...summary,
    apiKey: 'SECRET',
    extraBody: { secret: 'SECRET' },
    sources: { secret: ['SECRET'], max_output_tokens: ['cli_environment', 'SECRET'] },
    requestOverrideFields: ['thinking', 'SECRET'],
  })
  expect(JSON.stringify(parsed)).not.toContain('SECRET')
  expect(parsed?.sources).toEqual({ max_output_tokens: ['cli_environment'] })
  expect(readModelConfiguration({ ...summary, revision: 'not-a-revision' })).toBeUndefined()
})
test('shows next-turn defaults separately from the accepted session snapshot', () => {
  render(
    <ModelConfigurationDetails
      model={{
        name: 'p::m',
        type: 'runtime',
        config: {
          modelConfiguration: summary,
          activeModelConfiguration: {
            ...summary,
            boundary: 'session_snapshot',
            maxOutputTokens: 1024,
          },
          modelExecutionScope: {
            targetId: 'remote',
            accountMode: 'account',
            username: 'alice',
            principalId: 'principal',
          },
        },
      }}
    />
  )
  expect(screen.getByTestId('model-configuration-next_turn')).toHaveTextContent('2,048')
  expect(screen.getByTestId('model-configuration-session_snapshot')).toHaveTextContent('1,024')
  expect(screen.getByTestId('model-configuration-details')).toHaveTextContent('alice')
  expect(screen.getByTestId('model-configuration-next_turn')).toHaveTextContent(
    'source_cli_environment'
  )
})

test('a default capability is unknown even when another capability was explicitly declared', () => {
  render(
    <ModelConfigurationDetails
      model={{
        name: 'p::m',
        type: 'runtime',
        config: {
          modelConfiguration: {
            ...summary,
            sources: { 'capabilities.vision': ['user'], 'capabilities.reasoning': ['default'] },
          },
        },
      }}
    />
  )
  const declarations = screen.getByTestId('model-capability-declarations')
  expect(declarations).toHaveTextContent('modelConfiguration.capability_vision')
  expect(declarations).toHaveTextContent('modelConfiguration.disabled')
  expect(declarations).toHaveTextContent('modelConfiguration.capability_reasoning')
  expect(declarations).toHaveTextContent('modelConfiguration.unknown')
  expect(declarations).not.toHaveTextContent('medium')
})

test('reasoning policy reads serde defaults and custom efforts without accepting secret fields', () => {
  expect(readReasoningPolicy({ mode: 'hidden' })).toEqual({ mode: 'hidden', efforts: [] })
  expect(
    readReasoningPolicy({ mode: 'optional', efforts: ['vendor_effort', 'vendor_effort'] })
  ).toEqual({ mode: 'optional', efforts: ['vendor_effort'] })
  expect(readReasoningPolicy({ mode: 'optional', efforts: [' \t\u0085'] })).toBeUndefined()
  expect(readReasoningPolicy({ mode: 'hidden', apiKey: 'SECRET' })).toBeUndefined()
})

test('projects real registry facts separately from capability and old missing facts', () => {
  const parsed = readModelConfiguration({
    ...summary,
    tools: false,
    toolSet: {
      profile: 'nano',
      registryScope: 'session_role',
      registeredToolCount: 2,
      exposedToolCount: 0,
      description: 'PRIVATE',
    },
    sources: { 'tools.profile': ['cli_environment', 'PRIVATE'] },
  })
  expect(parsed?.tools).toBe(false)
  expect(parsed?.toolSet?.registeredToolCount).toBe(2)
  expect(parsed?.toolSet?.exposedToolCount).toBe(0)
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE')
  expect(parsed?.sources['tools.profile']).toEqual(['cli_environment'])
  expect(readModelConfiguration(summary)?.toolSet).toBeUndefined()
  expect(
    readModelConfiguration({
      ...summary,
      toolSet: { profile: '/private/path', registryScope: 'session_registry' },
    })?.toolSet?.profile
  ).toBeNull()
})
