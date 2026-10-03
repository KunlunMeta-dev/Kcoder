CREATE TABLE knowledge_sources (
 library_id TEXT NOT NULL, source_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 request_key TEXT NOT NULL, title TEXT NOT NULL, body_hash TEXT NOT NULL,
 PRIMARY KEY(library_id,source_id,revision_id), UNIQUE(library_id,request_key)
);
CREATE TABLE knowledge_chunks (
 library_id TEXT NOT NULL, source_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 chunk_id TEXT NOT NULL, ordinal INTEGER NOT NULL, first_line INTEGER NOT NULL, last_line INTEGER NOT NULL, text TEXT NOT NULL,
 PRIMARY KEY(library_id,source_id,revision_id,chunk_id)
);
CREATE TABLE knowledge_pages (
 library_id TEXT NOT NULL, page_id TEXT NOT NULL, current_revision TEXT NOT NULL,
 human_edited INTEGER NOT NULL CHECK(human_edited IN (0,1)),
 PRIMARY KEY(library_id,page_id)
);
CREATE TABLE knowledge_page_revisions (
 library_id TEXT NOT NULL, page_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 base_revision TEXT, title TEXT NOT NULL, kind TEXT NOT NULL, body_hash TEXT NOT NULL,
 citations_json TEXT NOT NULL, related_json TEXT NOT NULL,
 PRIMARY KEY(library_id,page_id,revision_id)
);
CREATE TABLE knowledge_commits (
 library_id TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(library_id,request_key)
);
PRAGMA user_version = 3;
