import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** Actual renderer view manager, installed Gateway attachment adapter and Native policy. */
export async function runWindowsTaskViewHandoff({ root, installation, init, rpc, client, thread, mainHandle, startHeldTurn }) {
  const { taskView } = await import(pathToFileURL(join(root, 'task-view-runtime.mjs')).href);
  const { BrokerSessionAttachments } = await import(pathToFileURL(join(installation, 'resources/gateway/src/broker-session-attachments.js')).href);
  const task = { taskId: `kcoder:local:${thread.id}`, threadId: thread.id };
  const pendingNative = [];
  let closed = false, pendingAliasResolve;
  const pendingAlias = new Promise(resolve => { pendingAliasResolve = resolve; });
  const transport = { channel: 'runtime', initialized: true };
  const broker = { clients: new Set([transport]), initializeResponse: { result: init },
    sendInternalRequest(method, params) { pendingNative.push(rpc(method, params)); } };
  const attachments = new BrokerSessionAttachments(broker);
  const flush = async () => { while (pendingNative.length) await Promise.all(pendingNative.splice(0)); };
  const viewClient = { supportsExperimental: () => true,
    async request(method, params) {
      assert.equal(closed, false, 'The original conversation connection must remain open');
      const changed = method.endsWith('/attach')
        ? attachments.attach(transport, params.threadId, params.viewId)
        : attachments.release(transport, params.threadId, params.viewId);
      await flush(); return { changed };
    },
    close() { closed = true; attachments.detach(transport); broker.clients.delete(transport); },
  };
  let resolved = false;
  const runtime = { taskViewGenerations: new Map(), tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, viewClient]]),
    resolveTaskId: id => id === 'pending-index-alias' ? resolved ? task.taskId : null : id,
    taskConnection: params => params.taskId === 'pending-index-alias'
      ? pendingAlias : Promise.resolve({ task, client: viewClient }),
  };
  const restoring = taskView(runtime, 'runtime.tasks.view.attach', { taskId: 'pending-index-alias', viewId: 'restoring-pane' });
  restoring.catch(() => {});
  try {
    resolved = true;
    await taskView(runtime, 'runtime.tasks.view.attach', { taskId: task.taskId, viewId: 'canonical-pane' });
    await rpc('thread/detach', { threadId: thread.id, ...mainHandle });
    const held = await startHeldTurn('Owned pending-view handoff protocol.');
    await taskView(runtime, 'runtime.tasks.view.release', { taskId: task.taskId, viewId: 'canonical-pane' });
    await flush();
    await delay(4200);
    const lifetime = await rpc('thread/lifetime/read', { threadId: thread.id });
    assert.ok(lifetime.attachedClients > 0,
      'A still-open restoring pane lost the original Native attachment: ' + JSON.stringify({ closed, lifetime }));
    const premature = client.notificationHistory.find(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === held.turn.id);
    assert.equal(premature, undefined, 'Metadata/alias restoration must not interrupt the original turn');
    pendingAliasResolve({ task, client: viewClient });
    await restoring;
    held.finish();
    const completed = await client.waitForNotification(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === held.turn.id, 20000);
    assert.equal(completed.params.turn.status, 'completed');
    const last = await startHeldTurn('Owned genuine last-view departure.');
    const detachedAt = Date.now();
    await taskView(runtime, 'runtime.tasks.view.release', { taskId: 'pending-index-alias', viewId: 'restoring-pane' });
    await flush();
    await delay(4200);
    const unattended = await rpc('thread/lifetime/read', { threadId: thread.id });
    assert.equal(unattended.attachedClients, 0);
    assert.equal(unattended.setting.mode, 'background');
    assert.equal(client.notificationHistory.some(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === last.turn.id), false,
      'Leaving the last view must not interrupt an authorized task');
    await rpc('turn/interrupt', { threadId: thread.id, turnId: last.turn.id });
    const stopped = await client.waitForNotification(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === last.turn.id, 20000);
    assert.equal(stopped.params.turn.status, 'interrupted');
    assert.equal(closed, true);
    assert.ok(client.methodsSent.includes('turn/interrupt'));
    return { pendingViewSurvivedBeyondGrace: true, completedOriginalTurn: true, lastViewStillDetaches: true,
      lastViewContinuesRunning: true, manualStopWorks: true, detachedObservationMs: Date.now() - detachedAt };
  } finally {
    pendingAliasResolve({ task, client: viewClient });
    await restoring.catch(() => {});
    attachments.detach(transport); attachments.clear(); await flush();
  }
}
