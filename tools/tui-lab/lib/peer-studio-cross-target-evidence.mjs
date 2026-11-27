import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const text = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).map(block => block.text ?? '').join('');

/** Evidence-only reads of these two owned profiles. No source grant or retry. */
export async function observeCrossTargetNativeEvidence({ actors, addresses, receipts, userTexts, peerTexts }) {
  assert.equal(actors.length, 2);
  assert.notEqual(addresses[0].targetId, addresses[1].targetId);
  assert.notEqual(addresses[0].workspaceId, addresses[1].workspaceId);
  assert.notEqual((await stat(actors[0].profile)).ino, (await stat(actors[1].profile)).ino);
  const evidence = [];
  for (let index = 0; index < 2; index++) {
    const actor = actors[index], address = addresses[index], sent = receipts[index], found = [];
    const visit = async (directory, depth = 0) => {
      assert.ok(depth <= 8);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !/^(?:checkpoints|context-history|llm-history|snapshots|archives|builtin-skills|skills|attachments|requests|cache|logs|usage)$/.test(entry.name)) await visit(file, depth + 1);
        else if (entry.isFile() && (entry.name === `${address.threadId}.jsonl`
          || entry.name === 'session.jsonl' && path.basename(directory) === address.threadId)) found.push(file);
      }
    };
    await visit(actor.profile); await visit(actor.workspace);
    assert.equal(found.length, 1, 'Exactly one original authoritative Native history per target');
    const rows = (await readFile(found[0], 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const messages = rows.map(row => row.message ?? row), peer = messages.filter(message => message.origin === 'peer_agent');
    assert.deepEqual(messages.filter(message => message.origin === 'user').map(text), [userTexts[index]]);
    assert.equal(peer.length, 1);
    assert.equal(text(peer[0]), peerTexts[index]);
    assert.equal(peer[0].agent_message.messageId, sent.messageId);
    assert.equal(peer[0].agent_message.bodySha256, digest(peerTexts[index]));
    assert.deepEqual(peer[0].agent_message.sourceAddress, sent.sourceAddress);
    assert.deepEqual(peer[0].agent_message.targetAddress, address);
    const directory = path.join(actor.profile, 'peer-router-v1', `mailbox-${address.workspaceId}`);
    const disk = JSON.parse(await readFile(path.join(directory, 'messages.json'), 'utf8'));
    assert.equal(disk.format, 'sqlite'); assert.match(disk.binding.child, /^receipt-archive-[A-Za-z0-9_-]+$/);
    // Loaded lazily: a top-level node:sqlite import prints an ExperimentalWarning
    // for every CLI invocation, including --help.
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(directory, disk.binding.child, 'catalog.sqlite3'), { readOnly: true });
    let terminal;
    try {
      const row = database.prepare('SELECT body,sha FROM receipt_archive_rows WHERE message_id=?').get(sent.messageId);
      assert.ok(row); assert.equal(digest(row.body), Buffer.from(row.sha).toString('hex'));
      terminal = JSON.parse(Buffer.from(row.body).toString('utf8')).value.receipt;
    } finally { database.close(); }
    assert.equal(terminal.status, 'applied');
    assert.equal(terminal.messageId, sent.messageId); assert.equal(terminal.clientMessageId, sent.clientMessageId);
    assert.deepEqual(terminal.sourceAddress, sent.sourceAddress); assert.deepEqual(terminal.targetAddress, address);
    evidence.push({ actor: actor.alias, address, file: found[0], rows, originalUserRows: 1, originalPeerRows: 1, receipt: terminal });
  }
  return evidence;
}
