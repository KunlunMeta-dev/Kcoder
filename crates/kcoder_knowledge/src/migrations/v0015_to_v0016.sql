ALTER TABLE knowledge_jobs ADD COLUMN progress_json TEXT;
ALTER TABLE knowledge_job_calls ADD COLUMN stage TEXT NOT NULL DEFAULT 'unspecified';
ALTER TABLE knowledge_job_calls ADD COLUMN after_chunk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_job_calls ADD COLUMN input_estimate INTEGER;
ALTER TABLE knowledge_stage_cache ADD COLUMN body_json TEXT;
