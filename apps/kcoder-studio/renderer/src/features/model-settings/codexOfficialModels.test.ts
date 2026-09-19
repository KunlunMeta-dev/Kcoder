import { describe, expect, test } from 'vitest'
import { codexModelPickerLabel, codexOfficialModelName, normalizeCodexOfficialModelList } from './codexOfficialModels'

describe('codexOfficialModels', () => {
  test('keeps execution identities distinct while displaying bare models', () => {
    const result = normalizeCodexOfficialModelList({ providers: [
      { id: 'first', type: 'provider', data: [{ id: 'first::same', model: 'same' }, { id: 'first::other', model: 'other' }] },
      { id: 'second', type: 'provider', data: [{ id: 'second::same', model: 'same' }] },
    ] })
    expect(result.models.map(codexOfficialModelName)).toEqual(['first::same', 'first::other', 'second::same'])
    expect(result.models.map(model => model.displayName)).toEqual(['same', 'other', 'same'])
  })
  test('preserves provider order and unknown model order while applying picker order', () => {
    const models = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'custom',
          data: [{ model: 'zeta' }, { model: 'alpha' }],
        },
        {
          id: 'openai',
          data: [{ model: 'gpt-5.4' }, { model: 'gpt-5.6-sol' }, { model: 'gpt-5.5' }],
        },
      ],
    })

    expect(models.providers.map(provider => provider.id)).toEqual(['custom', 'openai'])
    expect(models.models.map(model => model.modelId)).toEqual([
      'zeta',
      'alpha',
      'gpt-5.6-sol',
      'gpt-5.4',
    ])
  })

  test('maps requested picker names in the fixed product order', () => {
    const modelIds = [
      'gpt-5.3-codex-spark',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]
    const result = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'openai',
          displayName: 'CodeX',
          type: 'official',
          current: true,
          available: true,
          data: modelIds.map(model => ({
            id: model,
            model,
            displayName: model,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          })),
        },
      ],
    })

    expect(result.models.map(model => codexModelPickerLabel(model.modelId))).toEqual([
      'GPT 5.6 Sol',
      'GPT 5.6 Terra',
      'GPT 5.6 Luna',
      'GPT 5.4',
      'GPT 5.4 Mini',
      'GPT 5.3 Codex Spark',
    ])
  })

  test('filters legacy Codex picker models that should not be selectable', () => {
    const result = normalizeCodexOfficialModelList({
      data: [{ model: 'gpt-5.6-sol' }, { model: 'gpt-5.5' }],
    })

    expect(result.models.map(model => model.modelId)).toEqual(['gpt-5.6-sol'])
  })

  test('propagates provider availability and its sanitized error to picker models', () => {
    const result = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'kimi',
          available: false,
          error: 'provider credential is not configured',
          data: [{ model: 'kimi-for-coding' }],
        },
      ],
    })

    expect(result.models[0]).toMatchObject({
      modelId: 'kimi-for-coding',
      providerAvailable: false,
      providerError: 'provider credential is not configured',
    })
  })

  test('preserves the supported reasoning effort sequence advertised by Codex', () => {
    const result = normalizeCodexOfficialModelList({
      data: [
        {
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
            { reasoningEffort: 'ultra' },
          ],
          defaultReasoningEffort: 'low',
        },
      ],
    })

    expect(result.models[0]).toMatchObject({
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })
  })
})
