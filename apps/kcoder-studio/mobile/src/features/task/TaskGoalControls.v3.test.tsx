import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import { TaskGoalControls } from './TaskGoalControls';
import type { TaskSnapshot, ThreadGoal } from '@/runtime/task-runtime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('expo-router', () => ({ useIsFocused: () => false }));
vi.mock('react-native', async importOriginal => ({ ...await importOriginal<typeof import('react-native')>(),
  TextInput: 'TextInput',
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? <>{children}</> : null,
}));
vi.mock('@/storage/interface-version', () => ({ useInterfaceVersion: () => 'v3' }));
vi.mock('react-native-svg', () => ({ default: () => null, Path: () => null }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Check', 'ChevronRight', 'ListTodo', 'CirclePause', 'ChevronDown', 'ChevronUp', 'Pause', 'Pencil', 'PencilLine', 'Play', 'Target', 'Trash2', 'X'].map(name => [name, () => null])));

const goal: ThreadGoal = { threadId: 'thread', goalId: 'goal', revision: 4, objective: 'Keep the authoritative objective',
  mode: 'standard', verificationKind: 'artifact', status: 'active', tokenBudget: null, tokensUsed: 271580,
  timeUsedSeconds: 61.9, turnCount: 3, createdAt: 1, updatedAt: 2 };
const snapshot = { goal, threadId: 'thread', connected: true, messages: [], running: false } as unknown as TaskSnapshot;
const control = (renderer: ReactTestRenderer, id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.props.onPress === 'function')[0];

test('a plan without a Goal does not create a persistent V3 footer', async () => {
  const value = { ...snapshot, goal: null, messages: [{ id: 'plan', role: 'assistant', todos: [{ content: 'Recorded task', status: 'pending' }] }] } as TaskSnapshot;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskGoalControls task={{ snapshot: value } as never} snapshot={value} />); });
  expect(renderer.toJSON()).toBeNull();
  expect(control(renderer, 'task-goal-clear')).toBeUndefined();
  await act(async () => renderer.unmount());
});

test('Goal details do not duplicate the message checklist', async () => {
  const value = { ...snapshot, messages: [{ id: 'plan', role: 'assistant', content: '', timestampMs: 1,
    todos: [{ content: 'Current task', status: 'in_progress' }] }] } as TaskSnapshot;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskGoalControls task={{ snapshot: value } as never} snapshot={value} />); });
  expect(control(renderer, 'task-plan-summary')).toBeUndefined();
  expect(renderer.root.findAll(node => node.props.testID === 'task-goal-objective')).toHaveLength(0);
  await act(async () => control(renderer, 'task-goal-expand').props.onPress());
  expect(renderer.root.findAll(node => node.props.testID === 'task-plan-items')).toHaveLength(0);
  expect(renderer.root.findAll(node => node.props.testID === 'task-goal-objective').length).toBeGreaterThan(0);
  await act(async () => renderer.unmount());
});

test('V3 keeps details local and binds pause, edit and clear to the current Goal revision', async () => {
  const task = { snapshot, client: {}, clientGeneration: 1, disposed: false, goalProjectionVersion: 1,
    patch: vi.fn(), updateGoalStatus: vi.fn().mockResolvedValue(null), clearGoal: vi.fn().mockResolvedValue(null), editGoal: vi.fn().mockResolvedValue(null) };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskGoalControls task={task as never} snapshot={snapshot} />); });
  expect(renderer.root.findAll(node => node.props.testID === 'task-goal-objective')).toHaveLength(0);
  expect(renderer.root.findAll(node => node.props.testID === 'task-goal-queue')).toHaveLength(0);
  await act(async () => control(renderer, 'task-goal-expand').props.onPress());
  expect(renderer.root.findAll(node => node.props.testID === 'task-goal-objective')[0].props.children).toBe(goal.objective);
  await act(async () => control(renderer, 'task-goal-pause').props.onPress());
  expect(task.updateGoalStatus).toHaveBeenCalledWith('paused', goal);
  await act(async () => control(renderer, 'task-goal-edit').props.onPress());
  const input = renderer.root.findAll(node => node.props.testID === 'task-goal-edit-input' && typeof node.props.onChangeText === 'function')[0];
  await act(async () => input.props.onChangeText('Updated objective'));
  await act(async () => control(renderer, 'task-goal-save').props.onPress());
  expect(task.editGoal).toHaveBeenCalledWith('Updated objective', undefined, goal);
  await act(async () => control(renderer, 'task-goal-clear').props.onPress());
  expect(task.clearGoal).toHaveBeenCalledWith(goal);
  await act(async () => renderer.unmount());
});

test.each(['offline', 'unknown', 'archived'] as const)('V3 disables remote Goal mutations for %s while details stay readable', async reason => {
  const value = { ...snapshot, connected: reason !== 'offline', goalMutationUnknown: reason === 'unknown', archivedAt: reason === 'archived' ? '2026-10-26T00:00:00Z' : undefined };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskGoalControls task={{ snapshot: value } as never} snapshot={value} />); });
  for (const id of ['task-goal-edit', 'task-goal-pause', 'task-goal-clear']) expect(control(renderer, id).props.disabled).toBe(true);
  expect(control(renderer, 'task-goal-expand').props.disabled).not.toBe(true);
  await act(async () => control(renderer, 'task-goal-expand').props.onPress());
  expect(renderer.root.findAll(node => node.props.testID === 'task-goal-objective').length).toBeGreaterThan(0);
  await act(async () => renderer.unmount());
});

test.each(['paused', 'blocked', 'complete', 'budgetLimited'] as const)('V3 preserves status-specific actions for %s', async status => {
  const value = { ...snapshot, goal: { ...goal, status } };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskGoalControls task={{ snapshot: value } as never} snapshot={value} />); });
  expect(Boolean(control(renderer, 'task-goal-resume'))).toBe(['paused', 'blocked'].includes(status));
  expect(Boolean(control(renderer, 'task-goal-edit'))).toBe(['paused', 'blocked'].includes(status));
  expect(control(renderer, 'task-goal-clear')).toBeDefined();
  await act(async () => renderer.unmount());
});
