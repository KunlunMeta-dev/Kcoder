CREATE TABLE knowledge_jobs (
 library_id TEXT NOT NULL, job_id TEXT NOT NULL, request_key TEXT NOT NULL,
 source_id TEXT NOT NULL, source_revision TEXT NOT NULL, recipe_key TEXT NOT NULL,
 language TEXT NOT NULL, status TEXT NOT NULL, after_chunk INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until_ms INTEGER NOT NULL DEFAULT 0,
 checkpoint_json TEXT, error_code TEXT,
 PRIMARY KEY(library_id,job_id), UNIQUE(library_id,request_key)
);
CREATE INDEX knowledge_jobs_status ON knowledge_jobs(library_id,status,lease_until_ms);
PRAGMA user_version=5;
