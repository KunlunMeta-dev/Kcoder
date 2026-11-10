import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initLocale } from '@/i18n';
import type { TaskRuntime, TaskSnapshot, ModelOption } from '@/runtime/task-runtime';
import type { GatewayProfile } from '@/gateway/types';
import { useConversationModelLabel } from './use-conversation-model-label';

vi.hoisted(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null } }));
const option = (name: string, isDefault = true): ModelOption => ({ id: `provider::${name}`, model: name, displayName: name, providerId: 'provider', providerName: 'Provider', isDefault });
const profile = { id: 'owner', baseUrl: 'https://synthetic.invalid', authorizationGeneration: 'one' } as GatewayProfile;
function fixture() {
  const snapshot = { threadId: 'thread', cwd: '/project', connected: true } as TaskSnapshot;
  const request = vi.fn().mockResolvedValue({ data: [option('must-not-pick', false), option('Actual default')] });
  const task = { runtimeInstanceNonce: 1, clientGeneration: 1, getSnapshot: () => snapshot, request } as unknown as TaskRuntime;
  return { task, snapshot, request };
}
let renderer: TestRenderer.ReactTestRenderer;
function View({ task, snapshot, models = [], owner = profile }: { task: TaskRuntime; snapshot: TaskSnapshot; models?: ModelOption[]; owner?: GatewayProfile }) {
  return <span>{useConversationModelLabel(task, snapshot, models, owner)}</span>;
}
const text = () => renderer.root.findByType('span').children.join('');
beforeEach(() => initLocale('en'));
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });

test('reads the default from the conversation connection without changing its model or reading an unrelated target', async () => {
  const { task, snapshot, request } = fixture();
  await act(async () => { renderer = TestRenderer.create(<View task={task} snapshot={snapshot} />); });
  expect(text()).toBe('Follow target default (Actual default)');
  expect(request).toHaveBeenCalledExactlyOnceWith('runtime.models.list');
  expect(snapshot.model).toBeUndefined();
});

test('a response from the replaced authorization owner cannot overwrite the new display', async () => {
  const { task, snapshot, request } = fixture();
  let old!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
  await act(async () => { renderer = TestRenderer.create(<View task={task} snapshot={snapshot} />); });
  expect(text()).toBe('Follow target default');
  await act(async () => { renderer.update(<View task={task} snapshot={snapshot} owner={{ ...profile, authorizationGeneration: 'two' }} />); });
  expect(text()).toBe('Follow target default (Actual default)');
  await act(async () => { old({ data: [option('Wrong previous account')] }); });
  expect(text()).toBe('Follow target default (Actual default)');
});

test('keeps explicit or pending models distinct from defaults and does not perform a default lookup', async () => {
  const { task, snapshot, request } = fixture();
  snapshot.model = 'provider::explicit';
  await act(async () => { renderer = TestRenderer.create(<View task={task} snapshot={snapshot} models={[option('Target default'), option('explicit', false)]} />); });
  expect(text()).toBe('explicit');
  snapshot.pendingTurnPreferences = { model: 'provider::pending' };
  await act(async () => { renderer.update(<View task={task} snapshot={snapshot} models={[option('pending', false)]} />); });
  expect(text()).toBe('pending');
  expect(request).not.toHaveBeenCalled();
});

test('unknown defaults and disconnected conversations keep the unresolved label instead of guessing', async () => {
  const { task, snapshot, request } = fixture();
  request.mockResolvedValue({ data: [option('Not declared default', false)] });
  await act(async () => { renderer = TestRenderer.create(<View task={task} snapshot={snapshot} />); });
  expect(text()).toBe('Follow target default');
  snapshot.connected = false;
  await act(async () => { renderer.update(<View task={task} snapshot={snapshot} />); });
  expect(request).toHaveBeenCalledTimes(1);
});
