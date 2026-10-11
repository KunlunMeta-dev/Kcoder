import type { StagedAttachment } from "./task-runtime";
import { MAX_QUEUED_TASK_MESSAGES, MAX_TASK_MESSAGE_CHARACTERS } from "@/protocol/task-message-limits";

export interface QueuedTaskMessage {
  id: string;
  content: string;
  attachments: StagedAttachment[];
  createdAt: number;
  staging?: boolean;
}

type Listener = () => void;

export class TaskMessageQueue {
  private items: QueuedTaskMessage[] = [];
  private readonly listeners = new Set<Listener>();
  private preparationTail: Promise<void> = Promise.resolve();

  getSnapshot = (): readonly QueuedTaskMessage[] => this.items;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  enqueue(message: QueuedTaskMessage): void {
    if (this.items.length >= MAX_QUEUED_TASK_MESSAGES) throw new Error(`最多排队 ${MAX_QUEUED_TASK_MESSAGES} 条消息`);
    if (message.content.length > MAX_TASK_MESSAGE_CHARACTERS) throw new Error(`消息不能超过 ${MAX_TASK_MESSAGE_CHARACTERS.toLocaleString()} 个字符`);
    this.items = [...this.items, message];
    this.emit();
  }

  replace(messages: readonly QueuedTaskMessage[]): void {
    this.items = messages.map((message) => ({ ...message, attachments: [...message.attachments] }));
    this.emit();
  }

  markReady(id: string): void {
    this.items = this.items.map((item) => item.id === id ? { ...item, staging: false } : item);
    this.emit();
  }

  commitReady(id: string, persist: (messages: QueuedTaskMessage[]) => Promise<void>): Promise<void> {
    return this.persistProjection(async () => {
      if (!this.items.some((item) => item.id === id)) throw new Error("排队消息已移除");
      const messages = this.items.filter((item) => !item.staging || item.id === id)
        .map(({ staging: _staging, ...item }) => item);
      await persist(messages);
      this.markReady(id);
    });
  }

  persistProjection(operation: () => Promise<void>): Promise<void> {
    const next = this.preparationTail.catch(() => {}).then(operation);
    this.preparationTail = next;
    return next;
  }

  first(): QueuedTaskMessage | undefined {
    return this.items[0]?.staging ? undefined : this.items[0];
  }

  remove(id: string): QueuedTaskMessage | undefined {
    const removed = this.items.find((item) => item.id === id);
    if (!removed) return undefined;
    this.items = this.items.filter((item) => item.id !== id);
    this.emit();
    return removed;
  }

  takeFirst(): QueuedTaskMessage | undefined {
    const first = this.first();
    if (!first) return undefined;
    this.items = this.items.slice(1);
    this.emit();
    return first;
  }

  prepend(message: QueuedTaskMessage): void {
    this.items = [message, ...this.items.filter((item) => item.id !== message.id)];
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const queues = new WeakMap<object, TaskMessageQueue>();

export function taskMessageQueue(owner: object): TaskMessageQueue {
  const existing = queues.get(owner);
  if (existing) return existing;
  const created = new TaskMessageQueue();
  queues.set(owner, created);
  return created;
}
