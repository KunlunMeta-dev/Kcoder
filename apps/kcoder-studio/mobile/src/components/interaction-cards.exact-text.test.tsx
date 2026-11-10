import React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import type { AsyncQuestionRecord } from '@/runtime/task-runtime/types';

vi.mock('./ui', () => ({ Button: 'button' }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Pressable: 'button',
  ScrollView: 'div', StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'span', TextInput: 'input', View: 'div' }));
vi.mock('@/theme', () => ({
  useThemedStyles: (factory: (colors: unknown) => unknown) => factory({}),
  useTheme: () => ({ colors: {}, mode: 'light' }),
  radius: {}, spacing: {},
}));
vi.mock('@/i18n/use-locale', () => ({ useLocale: () => 'en' }));
vi.mock('lucide-react-native', () => ({ CheckSquare: () => null, HelpCircle: () => null,
  ShieldCheck: () => null, Square: () => null }));
import { AsyncQuestionCard } from './interaction-cards';

test.each([false, true])('async free text preserves surrounding whitespace (multiSelect=%s)', async multiSelect => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const onAnswer = vi.fn(async (_input: unknown) => {});
  const text = '  保留原文  ';
  const question: AsyncQuestionRecord = { questionId: 'question', requestId: 'request',
    threadId: 'thread', sourceTurnId: 'turn', toolCallId: 'tool', revision: 1,
    createdAtMs: 1, status: 'pending', questions: [{ id: 'code', header: 'Code',
      question: 'Which code?', multiSelect, options: [{ id: 'keep', label: 'Keep existing code', description: '' }] }] };
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<AsyncQuestionCard question={question} ownerKey="owner"
    onAnswer={onAnswer} onCancel={async () => {}} onRefresh={() => {}} />); });
  try {
    const byId = (id: string) => renderer.root.findAll(node => node.props.testID === id)[0]!;
    if (multiSelect) await act(async () => byId('async-question-question-option-code-keep').props.onPress());
    const input = renderer.root.findByType('input');
    await act(async () => input.props.onChangeText(text));
    await act(async () => byId('async-question-submit-question').props.onPress());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      questionId: 'question', expectedRevision: 1,
      answers: { code: { selectedOptionIds: multiSelect ? ['keep'] : [], text } },
    }));
  } finally { await act(async () => renderer.unmount()); }
});
