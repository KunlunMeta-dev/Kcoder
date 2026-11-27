CREATE TABLE IF NOT EXISTS memory_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    project_key TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at_epoch INTEGER NOT NULL,
    ended_at_epoch INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_memory_sessions_project_time
    ON memory_sessions(project_key, started_at_epoch DESC);

CREATE TABLE IF NOT EXISTS memory_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt_number INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    UNIQUE(session_id, prompt_number)
);

CREATE INDEX IF NOT EXISTS idx_memory_prompts_session_time
    ON memory_prompts(session_id, created_at_epoch DESC);

CREATE TABLE IF NOT EXISTS memory_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    prompt_number INTEGER,
    type TEXT NOT NULL,
    title TEXT,
    subtitle TEXT,
    narrative TEXT,
    facts_json TEXT NOT NULL DEFAULT '[]',
    concepts_json TEXT NOT NULL DEFAULT '[]',
    files_read_json TEXT NOT NULL DEFAULT '[]',
    files_modified_json TEXT NOT NULL DEFAULT '[]',
    tool_name TEXT,
    tool_call_id TEXT,
    source TEXT NOT NULL,
    generated_by_model TEXT,
    content_hash TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    hidden_at_epoch INTEGER,
    UNIQUE(project_key, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_observations_project_time
    ON memory_observations(project_key, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_memory_observations_type_time
    ON memory_observations(type, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_memory_observations_session_time
    ON memory_observations(session_id, created_at_epoch DESC);

CREATE TABLE IF NOT EXISTS memory_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    prompt_number INTEGER,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    notes TEXT,
    created_at_epoch INTEGER NOT NULL,
    hidden_at_epoch INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_summaries_project_time
    ON memory_summaries(project_key, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_session_time
    ON memory_summaries(session_id, created_at_epoch DESC);

CREATE TABLE IF NOT EXISTS memory_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_kind TEXT NOT NULL,
    memory_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at_epoch INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_memory
    ON memory_sources(memory_kind, memory_id);
