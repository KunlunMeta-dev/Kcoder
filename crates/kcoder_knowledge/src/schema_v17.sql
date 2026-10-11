ALTER TABLE knowledge_jobs ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE knowledge_pipeline_stages (
    library_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    batch INTEGER NOT NULL CHECK(batch >= 0),
    stage_key TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    raw_response TEXT,
    raw_hash TEXT,
    output_json TEXT,
    output_hash TEXT,
    PRIMARY KEY(library_id,job_id,batch,stage_key,unit_key)
);
CREATE TABLE knowledge_automatic_merge_leases (
    library_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    job_token TEXT NOT NULL,
    merge_token TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
PRAGMA user_version=17;
