import { afterEach, expect, it, vi } from 'vitest';
import { TaskRuntime, taskRuntimeTestHelpers } from './task-runtime';
import { FakeClient, profile, server } from './task-runtime/fixture.test-support';
vi.mock('@react-native-async-storage/async-storage', async () => {
  const { taskRuntimeAsyncStorage } = await import('@/test/task-runtime-async-storage-fixture');
  return { default: taskRuntimeAsyncStorage };
});
const runtimes = new Set<TaskRuntime>();
afterEach(() => { for (const runtime of runtimes) runtime.close(); runtimes.clear(); taskRuntimeTestHelpers.resetConnector(); });
async function fixture() {
  const client = new FakeClient([]);
  client.supportsExperimental = capability => capability === 'gatewaySharedThreadsV1';
  const request = client.request.bind(client);
  client.request = vi.fn(request) as never;
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile: { ...profile }, server, threadId: 'thread-1', cwd: '/workspace' });
  runtimes.add(runtime);
  return { client, runtime };
}

it('reads a peer user message while retaining streamed assistant text and the local composer state', async () => {
  const { client, runtime } = await fixture();
  const read = client.request.bind(client);
  client.request = vi.fn(async (method: string, params = {}) => method === 'thread/read' ? {
    thread: { id: 'thread-1' }, messages: [{ id: 'persisted-user', role: 'user', content: 'peer question',
      clientMessageId: 'stable-peer-message', turnId: 'peer-turn', timestampMs: 2 }], rangeStart: 0,
    rangeEnd: 1, hasMoreBefore: false,
  } : read(method, params)) as never;
  client.emit({ method: 'turn/started', params: { threadId: 'thread-1', turnId: 'peer-turn' } });
  client.emit({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'peer-turn',
    item: { id: 'assistant', type: 'agentMessage', text: 'live answer' } } });
  client.emit({ method: 'item/delta', params: { threadId: 'thread-1', turnId: 'peer-turn', itemId: 'assistant', delta: { text: 'live answer' } } });
  await vi.waitFor(() => expect(runtime.getSnapshot().messages.some(row => row.content === 'peer question')).toBe(true));
  expect(runtime.getSnapshot().messages.some(row => row.orderedBlocks?.some(block => block.kind === 'text' && block.content.includes('live answer')))).toBe(true);
  expect(runtime.getSnapshot()).toMatchObject({ running: true, connected: true, activeTurnId: 'peer-turn', error: null });
  expect(runtime.getSnapshot().messages.filter(row => row.role === 'user')).toHaveLength(1);
});

it('does not apply a delayed peer refresh after the runtime closes', async () => {
  const { client, runtime } = await fixture();
  let finish!: (value: unknown) => void;
  client.request = vi.fn(() => new Promise(resolve => { finish = resolve; })) as never;
  client.emit({ method: 'turn/started', params: { threadId: 'thread-1', turnId: 'peer-turn' } });
  runtime.close();
  const before = runtime.getSnapshot().messages;
  finish({ thread: { id: 'thread-1' }, messages: [{ id: 'late', role: 'user', content: 'late peer question', timestampMs: 3 }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(runtime.getSnapshot().messages).toBe(before);
});

it('coalesces a burst and retains one final read rather than reading on every streamed item', async () => {
  const { client, runtime } = await fixture();
  const reads: Array<(value: unknown) => void> = [];
  client.request = vi.fn(() => new Promise(resolve => reads.push(resolve))) as never;
  client.emit({ method: 'turn/started', params: { threadId: 'thread-1', turnId: 'peer-turn' } });
  for (let i = 0; i < 100; i++) client.emit({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'peer-turn', item: { type: 'agentMessage', id: `item-${i}`, text: 'stream' } } });
  expect(reads).toHaveLength(1);
  reads[0]({ thread: { id: 'thread-1' }, messages: [], hasMoreBefore: false });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  reads[1]({ thread: { id: 'thread-1' }, messages: [], hasMoreBefore: false });
});

it('ignores an old peer history response after authorization changes on the same profile object', async () => {
  const { client, runtime } = await fixture();
  let finish!: (value: unknown) => void;
  client.request = vi.fn(() => new Promise(resolve => { finish = resolve; })) as never;
  client.emit({ method: 'turn/started', params: { threadId: 'thread-1', turnId: 'peer-turn' } });
  runtime.reconnectContext!.profile.accessToken = 'replacement-authorization';
  finish({ thread: { id: 'thread-1' }, messages: [{ id: 'old', role: 'user', content: 'old authorization history', timestampMs: 3 }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(runtime.getSnapshot().messages.some(row => row.content === 'old authorization history')).toBe(false);
});
