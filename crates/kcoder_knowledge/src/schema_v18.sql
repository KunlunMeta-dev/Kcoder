CREATE TABLE knowledge_image_imports(
 library_id TEXT NOT NULL, id TEXT NOT NULL, request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL, title TEXT NOT NULL, original_hash TEXT NOT NULL, mime TEXT NOT NULL,
 source_id TEXT, expected_revision TEXT, status TEXT NOT NULL, phase TEXT NOT NULL,
 model TEXT, recipe TEXT, response_hash TEXT, error_code TEXT,
 lease_token TEXT, lease_until_ms INTEGER NOT NULL DEFAULT 0,
 call_limit INTEGER NOT NULL DEFAULT 1, text_bytes INTEGER NOT NULL DEFAULT 0,
 reasoning_bytes INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL,
 result_source_id TEXT, result_revision_id TEXT,
 PRIMARY KEY(library_id,id), UNIQUE(library_id,request_key)
);
CREATE TABLE knowledge_image_import_calls(
 library_id TEXT NOT NULL, import_id TEXT NOT NULL, call_id TEXT NOT NULL,
 lease_token TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
 completed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(library_id,import_id,call_id)
);
PRAGMA user_version=18;
