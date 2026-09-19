// Model-independent Gateway fixtures share metadata across transient RPC connections.
export class MockThreadStore {
  constructor(cwd, now = Date.now()) {
    this.threads = new Map([
      ['mock-active-session', { id: 'mock-active-session', title: '移动任务操作测试', status: 'idle', cwd, model: 'mock-mobile', createdAt: now - 120_000, updatedAt: now - 60_000 }],
      ['mock-archived-session', { id: 'mock-archived-session', title: '已归档移动任务', status: 'idle', cwd, model: 'mock-mobile', createdAt: now - 120_000, updatedAt: now - 60_000, archivedAt: '2026-07-29T00:00:00Z' }],
    ]);
  }
  read(id) { return structuredClone(this.threads.get(id) ?? { id, status: 'idle' }); }
  list(archived = false) {
    return [...this.threads.values()].filter(thread => Boolean(thread.archivedAt) === archived).map(thread => structuredClone(thread));
  }
  update(id, fields) {
    const thread = this.read(id);
    for (const key of ['title', 'model', 'archivedAt', 'parent']) {
      if (!(key in fields)) continue;
      if (fields[key] === null) delete thread[key];
      else thread[key] = structuredClone(fields[key]);
    }
    thread.updatedAt = Date.now();
    this.threads.set(id, thread);
    return this.read(id);
  }
  delete(id) { return this.threads.delete(id); }
}
