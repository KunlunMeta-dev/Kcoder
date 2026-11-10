import { createStoreFiles,openStoreFiles } from './store-bootstrap.mjs';
import { requireValue } from '../errors.mjs';
import { digest, identifier, privatePayload, scopeKey, ownerKey } from '../validation.mjs';

function rowValue(row) { return row ? JSON.parse(row.value_json) : null; }
export { verifyPrivateStoreRoot } from './store-bootstrap.mjs';
export class ConnectivityStore {
  static create(directory,options={}) {
    createStoreFiles(directory,options);
    return new ConnectivityStore(directory,options);
  }
  static open(directory,options={}) { return new ConnectivityStore(directory,options); }
  constructor(directory, { nativeWindowsProof, assertExclusiveLease, expectedNamespaceId, namespaceId, maxMetadataBytes = 64 * 1024 * 1024 } = {}) {
    this.storage=openStoreFiles(directory,{nativeWindowsProof,assertExclusiveLease,maxMetadataBytes,expectedNamespaceId:expectedNamespaceId??namespaceId});
    this.root=this.storage.root;this.db=this.storage.db;
  }
  assertOwnership(){this.storage.assertOwnership();}
  close(){this.storage.close();}
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  putEntity(kind, scope, id, value, expectedRevision = null) {
    return this.transaction(()=>this.putEntityInTransaction(kind,scope,id,value,expectedRevision));
  }
  putEntityInTransaction(kind,scope,id,value,expectedRevision=null){
    identifier(id);scopeKey(scope);const sk=ownerKey(scope),serialized=privatePayload(value);
    const existing=this.db.prepare('SELECT revision FROM entities WHERE kind=? AND scope=? AND id=?').get(kind,sk,id),revision=existing?.revision??0;
    requireValue(expectedRevision===null?revision===0:String(revision)===String(expectedRevision),'REVISION_CONFLICT','repair_configuration');
    this.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?) ON CONFLICT(kind,scope,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json').run(kind,sk,id,revision+1,serialized);
    return {...JSON.parse(serialized),id,revision:String(revision+1)};
  }
  readEntity(kind, scope, id) {
    const row = this.db.prepare('SELECT revision,value_json FROM entities WHERE kind=? AND scope=? AND id=?').get(kind, ownerKey(scope), identifier(id));
    return row ? { ...rowValue(row), id, revision: String(row.revision) } : null;
  }
  listEntities(kind, scope, { after = '', limit = 10, kinds, connectionId } = {}) {
    requireValue(Number.isInteger(limit) && limit > 0 && limit <= 100, 'INVALID_LIMIT');
    requireValue(kinds === undefined || Array.isArray(kinds) && kinds.length > 0 && kinds.length <= 16 && kinds.every(value => typeof value === 'string'), 'INVALID_ENTITY_FILTER');
    const filter = kinds ? ' AND json_extract(value_json,\'$.kind\') IN (' + kinds.map(() => '?').join(',') + ')' : '';
    if(connectionId!==undefined)identifier(connectionId);
    const ownerFilter=connectionId===undefined?'':" AND json_extract(value_json,'$.connectionId')=?";
    const parameters=connectionId===undefined?[]:[connectionId];
    const rows = this.db.prepare('SELECT id,revision,value_json FROM entities WHERE kind=? AND scope=? AND id>?' + filter + ownerFilter + ' ORDER BY id LIMIT ?').all(kind, ownerKey(scope), after, ...(kinds ?? []),...parameters, limit + 1);
    return { items: rows.slice(0, limit).map(r => ({ ...rowValue(r), id: r.id, revision: String(r.revision) })), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  beginOperation(scope, id, method, payload) {
    identifier(id); const fence = scopeKey(scope); const sk = ownerKey(scope); const intent = digest({ method, payload });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM operations WHERE scope=? AND id=?').get(sk, id);
      if (existing) {
        requireValue(existing.method === method && existing.intent === intent && existing.execution_scope === fence, 'OPERATION_INTENT_CONFLICT', 'explicit_user_decision');
        return { fresh: false, state: existing.state, result: existing.result_json ? JSON.parse(existing.result_json) : null };
      }
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,NULL,?)').run(sk, id, method, intent, 'pending', fence);
      return { fresh: true, state: 'pending', result: null };
    });
  }
  finishOperation(scope, id, result, state = 'completed') {
    const changed = this.db.prepare("UPDATE operations SET state=?,result_json=? WHERE scope=? AND id=? AND state='pending' AND execution_scope=?").run(state, privatePayload(result), ownerKey(scope), identifier(id), scopeKey(scope));
    requireValue(changed.changes === 1, 'OPERATION_ALREADY_SETTLED', 'reconcile_original');
  }
}
