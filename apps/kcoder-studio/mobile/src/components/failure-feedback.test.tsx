import React from 'react';
import { createRequire } from 'node:module';
import { beforeEach, expect, test, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { setLocale } from '@/i18n';
import type { ChatMessage, TaskActivityView } from '@/runtime/task-runtime/types';
import { messageProviderRetries, providerRetryCount, providerRetryProgress } from './provider-retry-presentation';
import { providerFailureSummary } from './provider-failure-presentation';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
vi.mock('@/theme', () => ({ useThemedStyles: (factory: (colors: unknown) => unknown) => factory({ text: '#222', textMuted: '#777', red: '#a22', border: '#ddd' }) }));
vi.mock('@/i18n/use-locale', () => ({ useLocale: () => 'zh-CN' }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (tag: string) => ({ children, testID, onPress, accessibilityState, disabled }: any) => React.createElement(tag, { 'data-testid': testID, 'aria-expanded': accessibilityState?.expanded, disabled, onClick: onPress }, children);
  return { Text: host('span'), View: host('div'), Pressable: host('button'), StyleSheet: { create: (styles: unknown) => styles } };
});
import { FailureContinuation } from './failure-continuation';
import { ProviderRetryNotice } from './provider-retry-notice';
const raw = (attempt: number) => `Provider main request failed for fixture model model-a (Provider error: unknown_error; HTTP 503. Response details withheld.); retrying ${attempt}/3 after 1082ms...`;
const activities: TaskActivityView[] = [1, 2, 3].map(attempt => ({ id: `retry-${attempt}`, type: 'notice', label: raw(attempt), status: 'completed' }));
const failure: ChatMessage = { id: 'failed', turnId: 'turn-1', role: 'assistant', status: 'failed', content: '', timestampMs: 1, error: 'HTTP 503. Service unavailable',
  providerFailure: { category: 'provider_error', recovery_action: 'diagnose_only', retryable: true, resume_safe: true, http_status: 503 }, activities };
const task = { continuationState: () => ({ allowed: true, unknown: false }), getSnapshot: () => ({ model: 'model-a' }), supportsCurrentConfigurationContinuation: () => true, continueFailed: vi.fn() };
beforeEach(() => { setLocale('zh-CN'); task.continueFailed.mockClear(); });
test('recognizes typed retry metadata and narrowly supports old retry notices without classifying normal output', () => {
  expect(providerRetryProgress({ ...activities[0], label: 'localized label', providerRetry: { attempt: 2, maxRetries: 3 } })).toEqual({ attempt: 2, maxRetries: 3 });
  expect(providerRetryCount(activities)).toBe(3);
  expect(providerRetryCount([...activities, { ...activities[0], id: 'next-request-retry' }])).toBe(4);
  expect(providerRetryProgress({ ...activities[0], type: 'activity' })).toBeUndefined();
  expect(providerRetryProgress({ ...activities[0], label: 'model says retrying 1/3' })).toBeUndefined();
  expect(messageProviderRetries({ activities, orderedBlocks: [] })).toEqual([]);
});
test('shows one concise failure, retry count and action, with raw diagnostics collapsed', () => {
  const html = renderToStaticMarkup(<FailureContinuation task={task as never} message={failure} busy={false} connected />);
  expect(html).toContain('模型服务暂不可用，请稍后重试。');
  expect(html).toContain('模型请求已重试 3 次');
  expect(html).toContain('从失败处继续');
  expect(html).not.toContain('Provider main request');
  expect(html).not.toContain('HTTP 503');
  expect(html).not.toContain('failure-recovery-facts');
  expect(html).not.toContain('已完成');
});
test('shows retry progress neutrally and reveals all original notices only on demand', async () => {
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(<ProviderRetryNotice activities={activities.slice(0, 2)} running />); });
  expect(JSON.stringify(view.toJSON())).toContain('正在重试（2/3）');
  expect(JSON.stringify(view.toJSON())).not.toContain(raw(1));
  await act(async () => { view.root.findByProps({ 'data-testid': 'provider-retry-toggle' }).props.onClick(); });
  expect(JSON.stringify(view.toJSON())).toContain(raw(1));
  expect(JSON.stringify(view.toJSON())).toContain(raw(2));
  expect(JSON.stringify(view.toJSON())).not.toContain('完成');
  await act(async () => { view.unmount(); });
});
test('keeps a continued failure collapsed in history; readonly details remain available without recovery actions', async () => {
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(<FailureContinuation message={{ ...failure, continuedByAttemptId: 'attempt-2' }} readOnly busy={false} connected={false} />); });
  expect(JSON.stringify(view.toJSON())).toContain('先前请求失败，已继续');
  expect(JSON.stringify(view.toJSON())).not.toContain('HTTP 503');
  await act(async () => { view.root.findByProps({ 'data-testid': 'continued-failure-toggle' }).props.onClick(); });
  expect(JSON.stringify(view.toJSON())).toContain('HTTP 503');
  expect(view.root.findAllByProps({ 'data-testid': 'message-continue-failure' })).toHaveLength(0);
  await act(async () => { view.unmount(); });
});
test('preserves unknown-receipt checking and continuation guards', () => {
  const html = renderToStaticMarkup(<FailureContinuation task={{ ...task, continuationState: () => ({ allowed: false, unknown: true }) } as never} message={failure} busy={false} connected />);
  expect(html).toContain('核对执行状态');
  expect(html).toContain('disabled');
  expect(html).not.toContain('message-continue-selected-model');
  expect(task.continueFailed).not.toHaveBeenCalled();
});
test('503 has a service-availability summary while configuration errors retain their specific guidance', () => {
  expect(providerFailureSummary(failure.providerFailure)).toContain('暂不可用');
  expect(providerFailureSummary({ ...failure.providerFailure!, category: 'authentication_error', http_status: 401 })).toContain('认证');
});

test('continuing an expanded failure collapses its historical record immediately', async () => {
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(<FailureContinuation task={task as never} message={failure} busy={false} connected />); });
  await act(async () => { view.root.findByProps({ 'data-testid': 'failure-technical-details' }).props.onClick(); });
  expect(view.root.findAllByProps({ 'data-testid': 'failure-recovery-facts' })).toHaveLength(1);
  await act(async () => { view.update(<FailureContinuation task={task as never} message={{ ...failure, continuedByAttemptId: 'next-attempt' }} busy={false} connected />); });
  expect(view.root.findAllByProps({ 'data-testid': 'failure-recovery-facts' })).toHaveLength(0);
  expect(view.root.findByProps({ 'data-testid': 'continued-failure-toggle' }).props['aria-expanded']).toBe(false);
  await act(async () => { view.unmount(); });
});
