// Frozen sealed-store baseline. Version changes require an authenticated Native
// owner to publish the schema and its original binding/ready receipts together.
export const STORE_SCHEMA_VERSION = '4';
export const STORE_SCHEMA_SQL=[
  'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  'CREATE TABLE entities(kind TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(kind,scope,id))',
  'CREATE TABLE operations(scope TEXT NOT NULL,id TEXT NOT NULL,method TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,execution_scope TEXT NOT NULL,PRIMARY KEY(scope,id))',
  'CREATE TABLE inbox(id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,scope TEXT NOT NULL,channel_id TEXT NOT NULL,state TEXT NOT NULL,native_id TEXT NOT NULL,received_at INTEGER NOT NULL,event_json TEXT NOT NULL,result_json TEXT)',
  'CREATE INDEX inbox_state ON inbox(state,received_at)',
  'CREATE TABLE outbox(owner TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,payload_json TEXT NOT NULL,lease TEXT,cancelled INTEGER NOT NULL DEFAULT 0,result_json TEXT,PRIMARY KEY(owner,id))',
  'CREATE INDEX outbox_state ON outbox(state,created_at)',
  'CREATE TABLE leases(resource TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,expires_at INTEGER NOT NULL)',
];
