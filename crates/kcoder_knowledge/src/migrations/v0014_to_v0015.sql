CREATE TABLE knowledge_source_extractions(library_id TEXT NOT NULL,source_id TEXT NOT NULL,revision_id TEXT NOT NULL,summary_json TEXT NOT NULL,PRIMARY KEY(library_id,source_id,revision_id));
