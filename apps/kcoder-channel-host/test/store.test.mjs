import { createFixtureStore,removeFixtureStore } from './store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectivityStore } from '../src/applications/store.mjs';

const scope = { accountId: 'alice', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' };
const peer = { ...scope, accountId: 'bob' };
test('POSIX initialization flushes the directory that contains the sibling binding file', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-store-durability-'));
  t.after(() => removeFixtureStore(root));
  const parent = fs.statSync(tmpdir()); const directories = [];
  const original = fs.fsyncSync;
  const mocked = t.mock.method(fs, 'fsyncSync', fd => {
    const metadata = fs.fstatSync(fd);
    if (metadata.isDirectory()) directories.push({ dev: metadata.dev, ino: metadata.ino });
    return original(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const store = createFixtureStore(root); store.close();
  assert.ok(directories.some(value => value.dev === parent.dev && value.ino === parent.ino));
});
function fixture(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-channel-store-'));
  const store = createFixtureStore(root, options);
  t.after(() => { store.close(); removeFixtureStore(root); });
  return { root, store };
}
test('application configuration and completed operation receipts survive reopening', t => {
  const { root, store } = fixture(t);
  store.putEntity('connection', scope, 'app', { kind: 'agentmail', label: 'Mailbox' });
  store.beginOperation(scope, 'save-app', 'save', { connectionId: 'app' });
  store.finishOperation(scope, 'save-app', { connectionId: 'app' });
  const reopened = new ConnectivityStore(root, { assertExclusiveLease: () => true });
  t.after(() => reopened.close());
  assert.equal(reopened.readEntity('connection', scope, 'app').label, 'Mailbox');
  assert.deepEqual(reopened.beginOperation(scope, 'save-app', 'save', { connectionId: 'app' }),
    { fresh: false, state: 'completed', result: { connectionId: 'app' } });
});

test('entity revisions are CAS protected and preserve account boundaries',t=>{
  const {store}=fixture(t);
  const r=store.putEntity('connection',scope,'conn',{kind:'qq'});
  assert.equal(r.revision,'1');
  assert.equal(store.readEntity('connection',peer,'conn'),null);
  assert.throws(()=>store.putEntity('connection',scope,'conn',{kind:'wecom'}),/REVISION_CONFLICT/);
  assert.equal(store.putEntity('connection',scope,'conn',{kind:'wecom'},'1').revision,'2');
});
test('operation identity cannot be reused for a different method or payload',t=>{
  const {store}=fixture(t);
  assert.equal(store.beginOperation(scope,'op','save',{value:1}).fresh,true);
  assert.equal(store.beginOperation(scope,'op','save',{value:1}).fresh,false);
  assert.throws(()=>store.beginOperation(scope,'op','save',{value:2}),/OPERATION_INTENT_CONFLICT/);
});
test('stable entities survive identity refresh while old operation intents keep their fence',t=>{
  const {store}=fixture(t);
  store.putEntity('connection',scope,'conn',{kind:'qq'});
  const refreshed={...scope,identityGeneration:'2',targetRevision:'3',organizationId:null};
  assert.equal(store.readEntity('connection',refreshed,'conn').revision,'1');
  store.beginOperation(scope,'op','save',{value:1});
  assert.throws(()=>store.beginOperation(refreshed,'op','save',{value:1}),/OPERATION_INTENT_CONFLICT/);
  const organization={...scope,organizationId:'organization'};
  assert.equal(store.readEntity('connection',organization,'conn'),null);
});
test('private store refuses a symlink or hard linked database', t=>{
  if(process.platform==='win32')return t.skip('POSIX filesystem guard; Windows needs native proof');
  const root=mkdtempSync(join(tmpdir(),'kcoder-channel-links-'));const initial=createFixtureStore(root);initial.close();rmSync(join(root,'connectivity.sqlite3'));const other=join(root,'other');writeFileSync(other,'');
  t.after(()=>removeFixtureStore(root));
  symlinkSync(other,join(root,'connectivity.sqlite3'));
  assert.throws(()=>new ConnectivityStore(root));
  rmSync(join(root,'connectivity.sqlite3'));linkSync(other,join(root,'connectivity.sqlite3'));
  assert.throws(()=>new ConnectivityStore(root),/UNSAFE_STORE_FILE/);
});
