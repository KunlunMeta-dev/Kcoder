CREATE TABLE knowledge_stage_cache(library_id TEXT NOT NULL,job_id TEXT NOT NULL,request_hash TEXT NOT NULL,body_hash TEXT NOT NULL,PRIMARY KEY(library_id,job_id,request_hash));
