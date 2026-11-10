import assert from 'node:assert/strict';
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { linuxDescendantIdentities, parseLinuxProcessStat } from './migration-large-history.mjs';
import { isTurnCompletion } from './rpc.mjs';
import { waitFor } from './run-context.mjs';

async function identity(pid) {
  return parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
}
async function present(original) {
  try { return (await identity(original.pid)).startTicks === original.startTicks; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
}
async function exactOwnedNativeProcesses(root, binary) {
  const processes = await linuxDescendantIdentities(await identity(root.pid));
  const matches = [];
  for (const process of processes) {
    const executable = await readlink(`/proc/${process.pid}/exe`).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
      throw error;
    });
    if (executable === binary) matches.push(process);
  }
  return matches;
}
async function launchCounts(context, gateway) {
  const gatewayLog = await readFile(gateway.logPath, 'utf8');
  const sshLog = await readFile(join(context.logsDir, 'sshd.log'), 'utf8');
  return {
    nativeOpens: gatewayLog.split('\n').filter(line => {
      try { const row = JSON.parse(line); return row.event === 'native-remote-host' && row.stage === 'open_received'; }
      catch { return false; }
    }).length,
    authenticatedSshSessions: (sshLog.match(/Accepted publickey for /g) || []).length,
  };
}

/** Cancel only the operation created by the actual Source turn. No reconnect,
 * replacement task, provider retry or SSH transport is created by this probe. */
export async function observeOriginalRemoteCancellation(context, {
  rpc, scope, threadId, turnId, source, receiver, gateway, ssh, binary, getDelegated,
}) {
  const proof = { actualSourceAccepted: { threadId, turnId }, actualSourceBudget: true,
    fault: 'cancel_original', paidCalls: 0, actualCrossHost: false, businessCompleted: false };
  try {
    await waitFor(() => receiver.requests.length === 1 && receiver.activeResponseCount === 1,
      45000, 'the actual original Receiver Provider request before cancellation');
    const recent = await rpc.request('integrations/remotes/listOperations', {
      requestId: 'cancel-read-original-list', scope,
    });
    assert.equal(recent.total, 1, 'One Source turn must create one original delegation');
    assert.equal(recent.items.length, 1);
    const operationId = recent.items[0].operationId;
    proof.operationId = operationId;
    const read = id => rpc.request('integrations/remotes/readOperation', { requestId: id, scope, operationId });
    const before = await read('cancel-read-original-before');
    proof.before = before.snapshot;
    assert.equal(before.snapshot.receiver.status, 'accepted');
    assert.equal(before.snapshot.receiver.terminalConfirmed, false);
    assert.ok(before.snapshot.receiver.identity?.attemptId, 'The actual Receiver Accepted must be retained');
    proof.receiverProcesses = await exactOwnedNativeProcesses(ssh.child, binary);
    assert.ok(proof.receiverProcesses.length >= 2, 'Observe the actual owned ACP frontend and native backend before cancellation');
    proof.launchesBefore = await launchCounts(context, gateway);
    assert.equal(proof.launchesBefore.authenticatedSshSessions, 1);
    proof.cancel = await rpc.request('integrations/remotes/cancelOperation', {
      requestId: 'cancel-original-once', scope, operationId,
      expectedRevision: before.snapshot.operationRevision,
    });
    assert.equal(proof.cancel.outcome, 'cancellation_requested');
    assert.equal(proof.cancel.snapshot.operationPhase, 'cancel_requested');
    // The pending deterministic Provider stream is never released to fabricate
    // a successful response. The actual Receiver cancellation must abort it.
    const completion = await rpc.waitFor(message => isTurnCompletion(message, threadId, turnId),
      90000, 'original Source turn after exact operation cancellation');
    proof.sourceTerminalStatus = completion.params.turn.status;
    proof.delegated = getDelegated();
    proof.receiverHttpOutcomes = receiver.requestOutcomes.map(value => ({ ...value }));
    const snapshots = [];
    for (let index = 0; index < 3; index++) snapshots.push((await read(`cancel-read-original-after-${index}`)).snapshot);
    proof.after = snapshots;
    const settled = await rpc.request('integrations/remotes/listOperations', {
      requestId: 'cancel-read-original-list-after', scope,
    });
    proof.originalList = { total: settled.total, items: settled.items };
    proof.postsAfter = { source: source.requests.length, receiver: receiver.requests.length };
    proof.receiverProcessesStillPresent = [];
    for (const process of proof.receiverProcesses) if (await present(process)) proof.receiverProcessesStillPresent.push(process);
    const stableCounts = { source: source.requests.length, receiver: receiver.requests.length };
    await read('cancel-read-original-final-observation');
    assert.deepEqual({ source: source.requests.length, receiver: receiver.requests.length }, stableCounts,
      'Readback must not execute another model call');
    assert.equal(settled.total, 1);
    assert.deepEqual(settled.items.map(value => value.operationId), [operationId]);
    // Snapshot product receipts and exact Receiver exit before harness teardown.
    // Stop only this owned Gateway to flush its existing redacted diagnostics;
    // that teardown is never counted as Native owner-cleanup evidence.
    proof.receiverExitObservedBeforeHarnessStop = proof.receiverProcessesStillPresent.length === 0;
    await context.stopOwned('gateway');
    proof.launchesAfter = await launchCounts(context, gateway);
    assert.equal(proof.launchesAfter.nativeOpens, 1, 'Readback cannot open a replacement Native endpoint');
    assert.equal(proof.launchesAfter.authenticatedSshSessions, proof.launchesBefore.authenticatedSshSessions,
      'Readback cannot open a replacement SSH');
    assert.equal(receiver.requests.length, 1, 'The original dispatched Receiver call is never retried');
    assert.ok(proof.receiverHttpOutcomes.every(value => value.closed && value.aborted), 'Actual cancellation must abort the original Provider stream');
    for (const snapshot of snapshots) {
      assert.equal(snapshot.operationId, operationId);
      assert.deepEqual(snapshot.receiver.identity, before.snapshot.receiver.identity);
      assert.equal(snapshot.businessCompleted, false);
      assert.equal(snapshot.receiver.status, 'interrupted', 'Only the original Native Receiver can confirm interruption');
      assert.equal(snapshot.receiver.terminalConfirmed, true);
      assert.equal(snapshot.cleanup, 'confirmed', 'Actual Receiver tree exit and owned SSH exit remain required');
      assert.equal(snapshot.operationPhase, 'cancelled', 'Settle only the original requested cancellation after actual Interrupted and cleanup');
    }
    assert.deepEqual(proof.receiverProcessesStillPresent, [], 'The exact observed Receiver owners must actually exit');
    return { operationId, originalReceiverInterrupted: true, cleanupConfirmed: true,
      receiverPosts: receiver.requests.length, noReplacementTaskOrSsh: true, businessCompleted: false };
  } finally {
    await context.writeArtifactJson('original-ssh-cancellation-proof.json', proof);
  }
}
