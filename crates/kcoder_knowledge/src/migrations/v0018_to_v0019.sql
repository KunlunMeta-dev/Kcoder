ALTER TABLE knowledge_jobs ADD COLUMN tool_preflight TEXT;
ALTER TABLE knowledge_jobs ADD COLUMN publication_json TEXT;
ALTER TABLE knowledge_jobs ADD COLUMN notice_code TEXT;
ALTER TABLE knowledge_jobs ADD COLUMN focus_json TEXT;
CREATE TABLE knowledge_tool_loop_steps (
    library_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    batch INTEGER NOT NULL CHECK(batch >= 0),
    loop_key TEXT NOT NULL,
    step INTEGER NOT NULL CHECK(step >= 0),
    input_fingerprint TEXT NOT NULL,
    call_id TEXT,
    response_json TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    tool_results_json TEXT,
    tree_hash TEXT,
    read_revisions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('received','applied')),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY(library_id,job_id,batch,loop_key,step)
);
CREATE TABLE knowledge_page_findings (
    library_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    batch INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('unsupported','uncertain','unassessed')),
    code TEXT NOT NULL,
    first_line INTEGER NOT NULL,
    last_line INTEGER NOT NULL,
    body_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(library_id,finding_id)
);
CREATE INDEX knowledge_page_findings_revision ON knowledge_page_findings(library_id,page_id,revision_id);
CREATE TABLE knowledge_pending_units (
    library_id TEXT NOT NULL,
    pending_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    batch INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    chunk_ids_json TEXT NOT NULL,
    first_line INTEGER NOT NULL,
    last_line INTEGER NOT NULL,
    reason_code TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(library_id,pending_id)
);
CREATE INDEX knowledge_pending_units_source ON knowledge_pending_units(library_id,source_id,source_revision);
CREATE TABLE knowledge_finding_decisions (
    library_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('finding','pending')),
    target_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('confirmed','dismissed','organizing','resolved')),
    request_key TEXT,
    related_job_id TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(library_id,decision_id),
    UNIQUE(library_id,request_key)
);
CREATE INDEX knowledge_finding_decisions_target ON knowledge_finding_decisions(library_id,target_kind,target_id);
CREATE TABLE knowledge_job_outcomes (
    library_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    batch INTEGER NOT NULL,
    outcome_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(library_id,job_id,batch)
);
CREATE TABLE knowledge_revision_assessments (
    library_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    assessed INTEGER NOT NULL CHECK(assessed IN (0,1)),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(library_id,page_id,revision_id)
);
