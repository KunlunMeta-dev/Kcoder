import type { ComposerStagedAttachment } from "./types";
import type { WorkspaceFailedSubmission } from "@/storage/workspace-preferences";

export interface FailedTaskSubmission {
  id: string;
  content: string;
  attachments: ComposerStagedAttachment[];
  createdAt: number;
  outcome: "failed" | "unknown";
  retrying: boolean;
  phase?: "preparing" | "retaining" | "sending";
  error?: string;
}

export interface FailedTaskSubmissionStore {
  getSnapshot(): readonly FailedTaskSubmission[];
  subscribe(listener: () => void): () => void;
  hydrateOnce(items: readonly WorkspaceFailedSubmission[]): void;
  add(item: FailedTaskSubmission): void;
  update(
    id: string,
    update: (item: FailedTaskSubmission) => FailedTaskSubmission,
  ): void;
  find(id: string): FailedTaskSubmission | undefined;
  remove(id: string): FailedTaskSubmission | undefined;
}

class TaskSubmissionStore implements FailedTaskSubmissionStore {
  private items: FailedTaskSubmission[] = [];
  private readonly listeners = new Set<() => void>();
  private hydrated = false;

  getSnapshot = (): readonly FailedTaskSubmission[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  hydrateOnce(items: readonly WorkspaceFailedSubmission[]): void {
    if (this.hydrated) return;
    this.hydrated = true;
    const currentIds = new Set(this.items.map((item) => item.id));
    const hydratedItems = items
      .filter((item) => !currentIds.has(item.id))
      .map((item): FailedTaskSubmission => ({
        ...item,
        attachments: item.attachments.map((attachment) => ({ ...attachment })),
        retrying: false,
      }));
    if (hydratedItems.length > 0) {
      this.items = [...hydratedItems, ...this.items];
      this.emit();
    }
  }

  add(item: FailedTaskSubmission): void {
    const existing = this.items.findIndex(
      (candidate) => candidate.id === item.id,
    );
    this.items =
      existing < 0
        ? [...this.items, item]
        : this.items.map((candidate, index) =>
            index === existing ? item : candidate,
          );
    this.emit();
  }

  update(
    id: string,
    update: (item: FailedTaskSubmission) => FailedTaskSubmission,
  ): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.items = this.items.map((item, itemIndex) =>
      itemIndex === index ? update(item) : item,
    );
    this.emit();
  }

  find(id: string): FailedTaskSubmission | undefined {
    return this.items.find((item) => item.id === id);
  }

  remove(id: string): FailedTaskSubmission | undefined {
    const removed = this.find(id);
    if (!removed) return undefined;
    this.items = this.items.filter((item) => item.id !== id);
    this.emit();
    return removed;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<object, TaskSubmissionStore>();

export function failedTaskSubmissionsFor(
  owner: object,
): FailedTaskSubmissionStore {
  const existing = stores.get(owner);
  if (existing) return existing;
  const created = new TaskSubmissionStore();
  stores.set(owner, created);
  return created;
}
