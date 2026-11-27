import assert from 'node:assert/strict';

/** Owned server-side pauses; they never create model tools, client events or native receipts. */
export function createWebSourceGates() {
  const pending = new Map(), observations = [];
  return {
    observations,
    async pause(name, response) {
      assert.ok(!pending.has(name) && observations.length < 32, 'Source gate identities must be unique and bounded');
      const record = { name, entered: true, released: false, closedBeforeRelease: false, replyAttempted: false };
      observations.push(record);
      response.once('end', () => { if (!record.released) record.remoteEndedBeforeRelease = true; });
      response.once('close', () => { if (!record.released) record.closedBeforeRelease = true; });
      await new Promise(resolve => pending.set(name, { record, resolve }));
      record.replyAttempted = true; record.transportClosedAtReply = response.destroyed;
      return record;
    },
    release(name) {
      const gate = pending.get(name); if (!gate) return false;
      gate.record.released = true; pending.delete(name); gate.resolve(); return true;
    },
    releaseAll() { for (const gate of pending.values()) { gate.record.released = true; gate.resolve(); } pending.clear(); },
  };
}
