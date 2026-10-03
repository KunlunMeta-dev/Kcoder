use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::hash::Hash;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySessionInput {
    pub session_id: String,
    pub project_key: String,
    pub cwd: String,
    pub started_at_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySession {
    pub id: i64,
    pub session_id: String,
    pub project_key: String,
    pub cwd: String,
    pub started_at_epoch: u64,
    pub ended_at_epoch: Option<u64>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryPromptInput {
    pub session_id: String,
    pub prompt_number: u64,
    pub prompt_text: String,
    pub created_at_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryPrompt {
    pub id: i64,
    pub session_id: String,
    pub prompt_number: u64,
    pub prompt_text: String,
    pub created_at_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObservationInput {
    pub session_id: String,
    pub project_key: String,
    pub prompt_number: Option<u64>,
    pub observation_type: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub narrative: Option<String>,
    pub facts: Vec<String>,
    pub concepts: Vec<String>,
    pub files_read: Vec<String>,
    pub files_modified: Vec<String>,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub source: String,
    pub generated_by_model: Option<String>,
    pub created_at_epoch: u64,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObservation {
    pub id: i64,
    pub session_id: String,
    pub project_key: String,
    pub prompt_number: Option<u64>,
    pub observation_type: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub narrative: Option<String>,
    pub facts: Vec<String>,
    pub concepts: Vec<String>,
    pub files_read: Vec<String>,
    pub files_modified: Vec<String>,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub source: String,
    pub generated_by_model: Option<String>,
    pub content_hash: String,
    pub created_at_epoch: u64,
    pub hidden_at_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySourceInput {
    pub memory_kind: String,
    pub memory_id: i64,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub metadata_json: String,
    pub created_at_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySource {
    pub id: i64,
    pub memory_kind: String,
    pub memory_id: i64,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub metadata_json: String,
    pub created_at_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySummaryInput {
    pub session_id: String,
    pub project_key: String,
    pub prompt_number: Option<u64>,
    pub request: Option<String>,
    pub investigated: Option<String>,
    pub learned: Option<String>,
    pub completed: Option<String>,
    pub next_steps: Option<String>,
    pub notes: Option<String>,
    pub created_at_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySummary {
    pub id: i64,
    pub session_id: String,
    pub project_key: String,
    pub prompt_number: Option<u64>,
    pub request: Option<String>,
    pub investigated: Option<String>,
    pub learned: Option<String>,
    pub completed: Option<String>,
    pub next_steps: Option<String>,
    pub notes: Option<String>,
    pub created_at_epoch: u64,
    pub hidden_at_epoch: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MemoryOrderBy {
    Relevance,
    #[default]
    DateDesc,
    DateAsc,
}

#[derive(Debug, Clone, Default)]
pub struct MemorySearchOptions {
    pub project_key: Option<String>,
    pub observation_type: Option<String>,
    pub concepts: Vec<String>,
    pub files: Vec<String>,
    pub date_start_epoch: Option<u64>,
    pub date_end_epoch: Option<u64>,
    pub limit: Option<usize>,
    pub order_by: MemoryOrderBy,
}

#[derive(Debug, Clone, Default)]
pub struct MemorySummarySearchOptions {
    pub project_key: Option<String>,
    pub session_id: Option<String>,
    pub date_start_epoch: Option<u64>,
    pub date_end_epoch: Option<u64>,
    pub limit: Option<usize>,
    pub order_by: MemoryOrderBy,
}

pub struct StructuredMemoryStore {
    conn: Connection,
}

impl std::fmt::Debug for StructuredMemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StructuredMemoryStore")
            .finish_non_exhaustive()
    }
}

impl StructuredMemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create memory db dir {:?}", parent))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open memory sqlite database {:?}", path))?;
        let store = Self { conn };
        store.configure()?;
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn in_memory() -> Result<Self> {
        let store = Self {
            conn: Connection::open_in_memory().context("failed to open in-memory sqlite db")?,
        };
        store.configure()?;
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    fn configure(&self) -> Result<()> {
        self.conn
            .pragma_update(None, "foreign_keys", "ON")
            .context("failed to enable sqlite foreign keys")?;
        self.conn
            .pragma_update(None, "journal_mode", "WAL")
            .context("failed to set sqlite journal mode")?;
        // rusqlite defaults to a zero busy timeout, so any concurrent writer
        // (second terminal, background observer, cron job) fails instantly
        // with `database is locked`. Wait a few seconds instead.
        self.conn
            .pragma_update(None, "busy_timeout", 5000)
            .context("failed to set sqlite busy timeout")?;
        Ok(())
    }

    /// One-time migration for stores written before project keys gained a
    /// hash suffix: re-home rows from the legacy key to the current key so
    /// existing memories stay reachable. Returns the number of rows moved.
    pub fn migrate_project_key(&self, legacy: &str, current: &str) -> Result<usize> {
        if legacy == current {
            return Ok(0);
        }
        let transaction = self
            .conn
            .unchecked_transaction()
            .context("failed to start project-key migration transaction")?;
        let mut moved = 0;

        // Observation hashes include project_key, so a raw key update either
        // leaves a legacy hash behind (allowing a later duplicate) or collides
        // only in artificial same-hash fixtures. Recompute each row using the
        // current key, merge a real current-key duplicate when present, and
        // redirect its provenance before deleting the legacy row.
        let legacy_observations = {
            let mut statement = transaction.prepare(
                r#"
                SELECT id, type, title, narrative, files_modified_json,
                       concepts_json, content_hash
                FROM memory_observations
                WHERE project_key = ?1
                ORDER BY id
                "#,
            )?;
            let rows = statement.query_map([legacy], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, kind, title, narrative, files_json, concepts_json, old_hash) in legacy_observations
        {
            let files_modified = parse_json_array(files_json);
            let new_hash = if old_hash.starts_with("legacy-import:") {
                let concepts = parse_json_array(concepts_json);
                let category = concepts
                    .iter()
                    .find(|concept| concept.as_str() != "legacy-import")
                    .map(String::as_str)
                    .unwrap_or("general");
                legacy_import_content_hash(
                    current,
                    category,
                    narrative.as_deref().unwrap_or_default(),
                )
            } else if old_hash
                == observation_hash(
                    legacy,
                    &kind,
                    title.as_deref(),
                    narrative.as_deref(),
                    &files_modified,
                )
            {
                observation_hash(
                    current,
                    &kind,
                    title.as_deref(),
                    narrative.as_deref(),
                    &files_modified,
                )
            } else {
                // The public input supports caller-defined stable identities.
                // Preserve a hash that was not generated by our default
                // project-key-aware algorithm.
                old_hash
            };
            let duplicate_id = transaction
                .query_row(
                    "SELECT id FROM memory_observations
                     WHERE project_key = ?1 AND content_hash = ?2",
                    rusqlite::params![current, new_hash],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if let Some(duplicate_id) = duplicate_id {
                transaction.execute(
                    "UPDATE memory_sources SET memory_id = ?1
                     WHERE memory_kind = 'observation' AND memory_id = ?2",
                    rusqlite::params![duplicate_id, id],
                )?;
                moved +=
                    transaction.execute("DELETE FROM memory_observations WHERE id = ?1", [id])?;
            } else {
                moved += transaction.execute(
                    "UPDATE memory_observations
                     SET project_key = ?1, content_hash = ?2
                     WHERE id = ?3",
                    rusqlite::params![current, new_hash, id],
                )?;
            }
        }

        for table in ["memory_sessions", "memory_summaries"] {
            moved += transaction.execute(
                &format!("UPDATE {table} SET project_key = ?1 WHERE project_key = ?2"),
                rusqlite::params![current, legacy],
            )?;
        }
        transaction
            .commit()
            .context("failed to commit project-key migration")?;
        Ok(moved)
    }

    pub fn ensure_schema(&self) -> Result<()> {
        self.conn
            .execute_batch(
                r#"
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

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts USING fts5(
                    observation_id UNINDEXED,
                    project_key UNINDEXED,
                    title,
                    subtitle,
                    narrative,
                    facts,
                    concepts,
                    tokenize = 'unicode61'
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_summaries_fts USING fts5(
                    summary_id UNINDEXED,
                    project_key UNINDEXED,
                    session_id UNINDEXED,
                    request,
                    investigated,
                    learned,
                    completed,
                    next_steps,
                    notes,
                    tokenize = 'unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS memory_observations_ai
                    AFTER INSERT ON memory_observations
                BEGIN
                    INSERT INTO memory_observations_fts(
                        rowid, observation_id, project_key, title, subtitle, narrative, facts, concepts
                    )
                    VALUES (
                        new.id,
                        new.id,
                        new.project_key,
                        COALESCE(new.title, ''),
                        COALESCE(new.subtitle, ''),
                        COALESCE(new.narrative, ''),
                        COALESCE(new.facts_json, ''),
                        COALESCE(new.concepts_json, '')
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS memory_observations_ad
                    AFTER DELETE ON memory_observations
                BEGIN
                    DELETE FROM memory_observations_fts WHERE rowid = old.id;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_observations_au
                    AFTER UPDATE ON memory_observations
                BEGIN
                    DELETE FROM memory_observations_fts WHERE rowid = old.id;
                    INSERT INTO memory_observations_fts(
                        rowid, observation_id, project_key, title, subtitle, narrative, facts, concepts
                    )
                    VALUES (
                        new.id,
                        new.id,
                        new.project_key,
                        COALESCE(new.title, ''),
                        COALESCE(new.subtitle, ''),
                        COALESCE(new.narrative, ''),
                        COALESCE(new.facts_json, ''),
                        COALESCE(new.concepts_json, '')
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS memory_summaries_ai
                    AFTER INSERT ON memory_summaries
                BEGIN
                    INSERT INTO memory_summaries_fts(
                        rowid, summary_id, project_key, session_id, request,
                        investigated, learned, completed, next_steps, notes
                    )
                    VALUES (
                        new.id,
                        new.id,
                        new.project_key,
                        new.session_id,
                        COALESCE(new.request, ''),
                        COALESCE(new.investigated, ''),
                        COALESCE(new.learned, ''),
                        COALESCE(new.completed, ''),
                        COALESCE(new.next_steps, ''),
                        COALESCE(new.notes, '')
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS memory_summaries_ad
                    AFTER DELETE ON memory_summaries
                BEGIN
                    DELETE FROM memory_summaries_fts WHERE rowid = old.id;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_summaries_au
                    AFTER UPDATE ON memory_summaries
                BEGIN
                    DELETE FROM memory_summaries_fts WHERE rowid = old.id;
                    INSERT INTO memory_summaries_fts(
                        rowid, summary_id, project_key, session_id, request,
                        investigated, learned, completed, next_steps, notes
                    )
                    VALUES (
                        new.id,
                        new.id,
                        new.project_key,
                        new.session_id,
                        COALESCE(new.request, ''),
                        COALESCE(new.investigated, ''),
                        COALESCE(new.learned, ''),
                        COALESCE(new.completed, ''),
                        COALESCE(new.next_steps, ''),
                        COALESCE(new.notes, '')
                    );
                END;

                INSERT INTO memory_summaries_fts(
                    rowid, summary_id, project_key, session_id, request,
                    investigated, learned, completed, next_steps, notes
                )
                SELECT
                    s.id,
                    s.id,
                    s.project_key,
                    s.session_id,
                    COALESCE(s.request, ''),
                    COALESCE(s.investigated, ''),
                    COALESCE(s.learned, ''),
                    COALESCE(s.completed, ''),
                    COALESCE(s.next_steps, ''),
                    COALESCE(s.notes, '')
                FROM memory_summaries s
                WHERE NOT EXISTS (
                    SELECT 1 FROM memory_summaries_fts f WHERE f.rowid = s.id
                );
                "#,
            )
            .context("failed to initialize structured memory schema")?;

        self.ensure_column("memory_observations", "hidden_at_epoch", "INTEGER")?;
        self.ensure_column("memory_summaries", "hidden_at_epoch", "INTEGER")?;

        Ok(())
    }

    fn ensure_column(&self, table: &str, column: &str, definition: &str) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .with_context(|| format!("failed to inspect sqlite table {table}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>("name"))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.iter().any(|name| name == column) {
            return Ok(());
        }
        self.conn
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .with_context(|| format!("failed to add sqlite column {table}.{column}"))?;
        Ok(())
    }

    pub fn upsert_session(&self, input: &MemorySessionInput) -> Result<i64> {
        let started_at_epoch = u64_to_i64_saturating(input.started_at_epoch);
        self.conn
            .execute(
                r#"
                INSERT INTO memory_sessions (session_id, project_key, cwd, started_at_epoch, status)
                VALUES (?1, ?2, ?3, ?4, 'active')
                ON CONFLICT(session_id) DO UPDATE SET
                    project_key = excluded.project_key,
                    cwd = excluded.cwd
                "#,
                params![
                    input.session_id.as_str(),
                    input.project_key.as_str(),
                    input.cwd.as_str(),
                    started_at_epoch
                ],
            )
            .context("failed to upsert memory session")?;

        self.conn
            .query_row(
                "SELECT id FROM memory_sessions WHERE session_id = ?",
                params![input.session_id.as_str()],
                |row| row.get(0),
            )
            .context("failed to fetch memory session id")
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<MemorySession>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_sessions WHERE session_id = ?",
                params![session_id],
                row_to_session,
            )
            .optional()
            .context("failed to fetch memory session")
    }

    pub fn finish_session(
        &self,
        session_id: &str,
        ended_at_epoch: u64,
        status: &str,
    ) -> Result<bool> {
        let ended_at_epoch = u64_to_i64_saturating(ended_at_epoch);
        let rows = self
            .conn
            .execute(
                r#"
                UPDATE memory_sessions
                SET ended_at_epoch = ?2,
                    status = ?3
                WHERE session_id = ?1
                "#,
                params![session_id, ended_at_epoch, status],
            )
            .context("failed to finish memory session")?;
        Ok(rows > 0)
    }

    pub fn save_prompt(&self, input: &MemoryPromptInput) -> Result<i64> {
        let prompt_number = u64_to_i64_saturating(input.prompt_number);
        let created_at_epoch = u64_to_i64_saturating(input.created_at_epoch);
        self.conn
            .execute(
                r#"
                INSERT INTO memory_prompts (session_id, prompt_number, prompt_text, created_at_epoch)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(session_id, prompt_number) DO UPDATE SET
                    prompt_text = excluded.prompt_text,
                    created_at_epoch = excluded.created_at_epoch
                "#,
                params![
                    input.session_id.as_str(),
                    prompt_number,
                    input.prompt_text.as_str(),
                    created_at_epoch
                ],
            )
            .context("failed to save memory prompt")?;

        self.conn
            .query_row(
                "SELECT id FROM memory_prompts WHERE session_id = ? AND prompt_number = ?",
                params![input.session_id.as_str(), prompt_number],
                |row| row.get(0),
            )
            .context("failed to fetch memory prompt id")
    }

    pub fn get_prompt(&self, session_id: &str, prompt_number: u64) -> Result<Option<MemoryPrompt>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_prompts WHERE session_id = ? AND prompt_number = ?",
                params![session_id, u64_to_i64_saturating(prompt_number)],
                row_to_prompt,
            )
            .optional()
            .context("failed to fetch memory prompt")
    }

    pub fn insert_observation(&self, input: &MemoryObservationInput) -> Result<i64> {
        let facts_json = serde_json::to_string(&input.facts)?;
        let concepts_json = serde_json::to_string(&input.concepts)?;
        let files_read_json = serde_json::to_string(&input.files_read)?;
        let files_modified_json = serde_json::to_string(&input.files_modified)?;
        let content_hash = input.content_hash.clone().unwrap_or_else(|| {
            observation_hash(
                &input.project_key,
                &input.observation_type,
                input.title.as_deref(),
                input.narrative.as_deref(),
                &input.files_modified,
            )
        });
        let prompt_number = input.prompt_number.map(u64_to_i64_saturating);
        let created_at_epoch = u64_to_i64_saturating(input.created_at_epoch);

        let inserted = self
            .conn
            .execute(
                r#"
                INSERT OR IGNORE INTO memory_observations (
                    session_id, project_key, prompt_number, type, title, subtitle,
                    narrative, facts_json, concepts_json, files_read_json,
                    files_modified_json, tool_name, tool_call_id, source,
                    generated_by_model, content_hash, created_at_epoch
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                "#,
                params![
                    input.session_id.as_str(),
                    input.project_key.as_str(),
                    prompt_number,
                    input.observation_type.as_str(),
                    input.title.as_deref(),
                    input.subtitle.as_deref(),
                    input.narrative.as_deref(),
                    facts_json.as_str(),
                    concepts_json.as_str(),
                    files_read_json.as_str(),
                    files_modified_json.as_str(),
                    input.tool_name.as_deref(),
                    input.tool_call_id.as_deref(),
                    input.source.as_str(),
                    input.generated_by_model.as_deref(),
                    content_hash.as_str(),
                    created_at_epoch,
                ],
            )
            .context("failed to insert memory observation")?;

        if inserted > 0 {
            return Ok(self.conn.last_insert_rowid());
        }

        self.conn
            .query_row(
                "SELECT id FROM memory_observations WHERE project_key = ? AND content_hash = ?",
                params![input.project_key.as_str(), content_hash.as_str()],
                |row| row.get(0),
            )
            .context("failed to fetch existing memory observation id")
    }

    pub fn add_source(&self, input: &MemorySourceInput) -> Result<i64> {
        let created_at_epoch = u64_to_i64_saturating(input.created_at_epoch);
        self.conn
            .execute(
                r#"
                INSERT INTO memory_sources (
                    memory_kind, memory_id, source_type, source_ref, metadata_json, created_at_epoch
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    input.memory_kind.as_str(),
                    input.memory_id,
                    input.source_type.as_str(),
                    input.source_ref.as_deref(),
                    input.metadata_json.as_str(),
                    created_at_epoch
                ],
            )
            .context("failed to insert memory source")?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn sources_for_memory(
        &self,
        memory_kind: &str,
        memory_id: i64,
    ) -> Result<Vec<MemorySource>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT * FROM memory_sources
            WHERE memory_kind = ? AND memory_id = ?
            ORDER BY created_at_epoch ASC, id ASC
            "#,
        )?;
        let rows = stmt.query_map(params![memory_kind, memory_id], row_to_source)?;
        collect_rows(rows)
    }

    pub fn insert_summary(&self, input: &MemorySummaryInput) -> Result<i64> {
        let prompt_number = input.prompt_number.map(u64_to_i64_saturating);
        let created_at_epoch = u64_to_i64_saturating(input.created_at_epoch);
        self.conn
            .execute(
                r#"
                INSERT INTO memory_summaries (
                    session_id, project_key, prompt_number, request, investigated,
                    learned, completed, next_steps, notes, created_at_epoch
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    input.session_id.as_str(),
                    input.project_key.as_str(),
                    prompt_number,
                    input.request.as_deref(),
                    input.investigated.as_deref(),
                    input.learned.as_deref(),
                    input.completed.as_deref(),
                    input.next_steps.as_deref(),
                    input.notes.as_deref(),
                    created_at_epoch
                ],
            )
            .context("failed to insert memory summary")?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_summary(&self, id: i64) -> Result<Option<MemorySummary>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_summaries WHERE id = ? AND hidden_at_epoch IS NULL",
                params![id],
                row_to_summary,
            )
            .optional()
            .context("failed to fetch memory summary")
    }

    pub fn set_summary_hidden(&self, id: i64, hidden_at_epoch: Option<u64>) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE memory_summaries SET hidden_at_epoch = ? WHERE id = ?",
                params![hidden_at_epoch.map(u64_to_i64_saturating), id],
            )
            .context("failed to update memory summary visibility")?;
        Ok(changed > 0)
    }

    pub fn hidden_summaries(
        &self,
        project_key: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemorySummary>> {
        let mut sql = String::from(
            r#"
            SELECT * FROM memory_summaries
            WHERE hidden_at_epoch IS NOT NULL
            "#,
        );
        let mut params = Vec::<Value>::new();
        if let Some(project_key) = project_key {
            sql.push_str(" AND project_key = ?");
            params.push(Value::Text(project_key.to_string()));
        }
        sql.push_str(" ORDER BY hidden_at_epoch DESC, id DESC LIMIT ?");
        params.push(Value::Integer(limit.max(1) as i64));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), row_to_summary)?;
        collect_rows(rows)
    }

    pub fn count_summaries(
        &self,
        project_key: Option<&str>,
        hidden: Option<bool>,
    ) -> Result<usize> {
        count_memory_rows(&self.conn, "memory_summaries", project_key, hidden)
    }

    pub fn summaries_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<MemorySummary>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT * FROM memory_summaries
            WHERE session_id = ?
              AND hidden_at_epoch IS NULL
            ORDER BY created_at_epoch DESC, id DESC
            LIMIT ?
            "#,
        )?;
        let rows = stmt.query_map(params![session_id, limit.max(1) as i64], row_to_summary)?;
        collect_rows(rows)
    }

    pub fn summaries_for_project(
        &self,
        project_key: &str,
        limit: usize,
    ) -> Result<Vec<MemorySummary>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT * FROM memory_summaries
            WHERE project_key = ?
              AND hidden_at_epoch IS NULL
            ORDER BY created_at_epoch DESC, id DESC
            LIMIT ?
            "#,
        )?;
        let rows = stmt.query_map(params![project_key, limit.max(1) as i64], row_to_summary)?;
        collect_rows(rows)
    }

    pub fn search_summaries(
        &self,
        query: Option<&str>,
        options: &MemorySummarySearchOptions,
    ) -> Result<Vec<MemorySummary>> {
        let mut sql = String::from("SELECT s.* FROM memory_summaries s");
        let mut clauses = Vec::new();
        let mut params = Vec::<Value>::new();
        let fts = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(fts_query)
            .filter(|q| !q.is_empty());

        if let Some(query) = &fts {
            sql.push_str(" JOIN memory_summaries_fts ON memory_summaries_fts.rowid = s.id");
            clauses.push("memory_summaries_fts MATCH ?".to_string());
            params.push(Value::Text(query.clone()));
        }

        clauses.push("s.hidden_at_epoch IS NULL".to_string());
        append_summary_filters(options, &mut clauses, &mut params);

        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }

        match (fts.is_some(), options.order_by) {
            (true, MemoryOrderBy::Relevance) => {
                sql.push_str(" ORDER BY bm25(memory_summaries_fts), s.created_at_epoch DESC");
            }
            (_, MemoryOrderBy::DateAsc) => sql.push_str(" ORDER BY s.created_at_epoch ASC"),
            _ => sql.push_str(" ORDER BY s.created_at_epoch DESC"),
        }

        sql.push_str(" LIMIT ?");
        params.push(Value::Integer(
            options.limit.unwrap_or(DEFAULT_LIMIT).max(1) as i64,
        ));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), row_to_summary)?;
        collect_rows(rows)
    }

    pub fn get_observation(&self, id: i64) -> Result<Option<MemoryObservation>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_observations WHERE id = ? AND hidden_at_epoch IS NULL",
                params![id],
                row_to_observation,
            )
            .optional()
            .context("failed to fetch memory observation")
    }

    pub fn observation_by_content_hash(
        &self,
        project_key: &str,
        content_hash: &str,
    ) -> Result<Option<MemoryObservation>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_observations WHERE project_key = ? AND content_hash = ?",
                params![project_key, content_hash],
                row_to_observation,
            )
            .optional()
            .context("failed to fetch memory observation by content hash")
    }

    pub fn set_observation_hidden(&self, id: i64, hidden_at_epoch: Option<u64>) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE memory_observations SET hidden_at_epoch = ? WHERE id = ?",
                params![hidden_at_epoch.map(u64_to_i64_saturating), id],
            )
            .context("failed to update memory observation visibility")?;
        Ok(changed > 0)
    }

    pub fn hidden_observations(
        &self,
        project_key: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryObservation>> {
        let mut sql = String::from(
            r#"
            SELECT * FROM memory_observations
            WHERE hidden_at_epoch IS NOT NULL
            "#,
        );
        let mut params = Vec::<Value>::new();
        if let Some(project_key) = project_key {
            sql.push_str(" AND project_key = ?");
            params.push(Value::Text(project_key.to_string()));
        }
        sql.push_str(" ORDER BY hidden_at_epoch DESC, id DESC LIMIT ?");
        params.push(Value::Integer(limit.max(1) as i64));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), row_to_observation)?;
        collect_rows(rows)
    }

    pub fn count_observations(
        &self,
        project_key: Option<&str>,
        hidden: Option<bool>,
    ) -> Result<usize> {
        count_memory_rows(&self.conn, "memory_observations", project_key, hidden)
    }

    pub fn timeline_around_observation(
        &self,
        id: i64,
        before: usize,
        after: usize,
    ) -> Result<Vec<MemoryObservation>> {
        let Some(anchor) = self.get_observation(id)? else {
            return Ok(Vec::new());
        };

        let mut before_stmt = self.conn.prepare(
            r#"
            SELECT * FROM memory_observations
            WHERE session_id = ?
              AND hidden_at_epoch IS NULL
              AND (created_at_epoch < ? OR (created_at_epoch = ? AND id < ?))
            ORDER BY created_at_epoch DESC, id DESC
            LIMIT ?
            "#,
        )?;
        let before_rows = before_stmt.query_map(
            params![
                anchor.session_id.as_str(),
                u64_to_i64_saturating(anchor.created_at_epoch),
                u64_to_i64_saturating(anchor.created_at_epoch),
                anchor.id,
                before as i64
            ],
            row_to_observation,
        )?;
        let mut previous = collect_rows(before_rows)?;
        previous.reverse();

        let mut after_stmt = self.conn.prepare(
            r#"
            SELECT * FROM memory_observations
            WHERE session_id = ?
              AND hidden_at_epoch IS NULL
              AND (created_at_epoch > ? OR (created_at_epoch = ? AND id > ?))
            ORDER BY created_at_epoch ASC, id ASC
            LIMIT ?
            "#,
        )?;
        let after_rows = after_stmt.query_map(
            params![
                anchor.session_id.as_str(),
                u64_to_i64_saturating(anchor.created_at_epoch),
                u64_to_i64_saturating(anchor.created_at_epoch),
                anchor.id,
                after as i64
            ],
            row_to_observation,
        )?;

        let mut timeline = previous;
        timeline.push(anchor);
        timeline.extend(collect_rows(after_rows)?);
        Ok(timeline)
    }

    pub fn observations_by_ids(&self, ids: &[i64]) -> Result<Vec<MemoryObservation>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT * FROM memory_observations WHERE hidden_at_epoch IS NULL AND id IN ({placeholders}) ORDER BY created_at_epoch DESC"
        );
        let params = ids.iter().copied().map(Value::Integer).collect::<Vec<_>>();
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), row_to_observation)?;
        collect_rows(rows)
    }

    pub fn search_observations(
        &self,
        query: Option<&str>,
        options: &MemorySearchOptions,
    ) -> Result<Vec<MemoryObservation>> {
        let mut sql = String::from("SELECT o.* FROM memory_observations o");
        let mut clauses = Vec::new();
        let mut params = Vec::<Value>::new();
        let fts = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(fts_query)
            .filter(|q| !q.is_empty());

        if let Some(query) = &fts {
            sql.push_str(" JOIN memory_observations_fts ON memory_observations_fts.rowid = o.id");
            clauses.push("memory_observations_fts MATCH ?".to_string());
            params.push(Value::Text(query.clone()));
        }

        clauses.push("o.hidden_at_epoch IS NULL".to_string());
        append_filters(options, &mut clauses, &mut params);

        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }

        match (fts.is_some(), options.order_by) {
            (true, MemoryOrderBy::Relevance) => {
                sql.push_str(" ORDER BY bm25(memory_observations_fts), o.created_at_epoch DESC");
            }
            (_, MemoryOrderBy::DateAsc) => sql.push_str(" ORDER BY o.created_at_epoch ASC"),
            _ => sql.push_str(" ORDER BY o.created_at_epoch DESC"),
        }

        sql.push_str(" LIMIT ?");
        params.push(Value::Integer(
            options.limit.unwrap_or(DEFAULT_LIMIT).max(1) as i64,
        ));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), row_to_observation)?;
        collect_rows(rows)
    }
}

fn count_memory_rows(
    conn: &Connection,
    table: &str,
    project_key: Option<&str>,
    hidden: Option<bool>,
) -> Result<usize> {
    let table = match table {
        "memory_observations" => "memory_observations",
        "memory_summaries" => "memory_summaries",
        _ => anyhow::bail!("unsupported memory table for count: {table}"),
    };
    let mut sql = format!("SELECT COUNT(*) FROM {table}");
    let mut clauses = Vec::new();
    let mut params = Vec::<Value>::new();
    if let Some(project_key) = project_key {
        clauses.push("project_key = ?".to_string());
        params.push(Value::Text(project_key.to_string()));
    }
    if let Some(hidden) = hidden {
        clauses.push(if hidden {
            "hidden_at_epoch IS NOT NULL".to_string()
        } else {
            "hidden_at_epoch IS NULL".to_string()
        });
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    let count = conn
        .query_row(&sql, params_from_iter(params), |row| row.get::<_, i64>(0))
        .context("failed to count structured memories")?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

fn append_filters(
    options: &MemorySearchOptions,
    clauses: &mut Vec<String>,
    params: &mut Vec<Value>,
) {
    if let Some(project_key) = &options.project_key {
        clauses.push("o.project_key = ?".to_string());
        params.push(Value::Text(project_key.clone()));
    }

    if let Some(observation_type) = &options.observation_type {
        clauses.push("o.type = ?".to_string());
        params.push(Value::Text(observation_type.clone()));
    }

    if let Some(start) = options.date_start_epoch {
        clauses.push("o.created_at_epoch >= ?".to_string());
        params.push(Value::Integer(u64_to_i64_saturating(start)));
    }

    if let Some(end) = options.date_end_epoch {
        clauses.push("o.created_at_epoch <= ?".to_string());
        params.push(Value::Integer(u64_to_i64_saturating(end)));
    }

    for concept in &options.concepts {
        clauses
            .push("EXISTS (SELECT 1 FROM json_each(o.concepts_json) WHERE value = ?)".to_string());
        params.push(Value::Text(concept.clone()));
    }

    for file in &options.files {
        clauses.push(
            "(EXISTS (SELECT 1 FROM json_each(o.files_read_json) WHERE value LIKE ?) \
             OR EXISTS (SELECT 1 FROM json_each(o.files_modified_json) WHERE value LIKE ?))"
                .to_string(),
        );
        let pattern = format!("%{file}%");
        params.push(Value::Text(pattern.clone()));
        params.push(Value::Text(pattern));
    }
}

fn append_summary_filters(
    options: &MemorySummarySearchOptions,
    clauses: &mut Vec<String>,
    params: &mut Vec<Value>,
) {
    if let Some(project_key) = &options.project_key {
        clauses.push("s.project_key = ?".to_string());
        params.push(Value::Text(project_key.clone()));
    }

    if let Some(session_id) = &options.session_id {
        clauses.push("s.session_id = ?".to_string());
        params.push(Value::Text(session_id.clone()));
    }

    if let Some(start) = options.date_start_epoch {
        clauses.push("s.created_at_epoch >= ?".to_string());
        params.push(Value::Integer(u64_to_i64_saturating(start)));
    }

    if let Some(end) = options.date_end_epoch {
        clauses.push("s.created_at_epoch <= ?".to_string());
        params.push(Value::Integer(u64_to_i64_saturating(end)));
    }
}

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<MemorySession> {
    Ok(MemorySession {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        project_key: row.get("project_key")?,
        cwd: row.get("cwd")?,
        started_at_epoch: row
            .get::<_, i64>("started_at_epoch")?
            .try_into()
            .unwrap_or_default(),
        ended_at_epoch: row
            .get::<_, Option<i64>>("ended_at_epoch")?
            .and_then(|n| u64::try_from(n).ok()),
        status: row.get("status")?,
    })
}

fn row_to_prompt(row: &Row<'_>) -> rusqlite::Result<MemoryPrompt> {
    Ok(MemoryPrompt {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        prompt_number: row
            .get::<_, i64>("prompt_number")?
            .try_into()
            .unwrap_or_default(),
        prompt_text: row.get("prompt_text")?,
        created_at_epoch: row
            .get::<_, i64>("created_at_epoch")?
            .try_into()
            .unwrap_or_default(),
    })
}

fn row_to_observation(row: &Row<'_>) -> rusqlite::Result<MemoryObservation> {
    Ok(MemoryObservation {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        project_key: row.get("project_key")?,
        prompt_number: row
            .get::<_, Option<i64>>("prompt_number")?
            .and_then(|n| u64::try_from(n).ok()),
        observation_type: row.get("type")?,
        title: row.get("title")?,
        subtitle: row.get("subtitle")?,
        narrative: row.get("narrative")?,
        facts: parse_json_array(row.get("facts_json")?),
        concepts: parse_json_array(row.get("concepts_json")?),
        files_read: parse_json_array(row.get("files_read_json")?),
        files_modified: parse_json_array(row.get("files_modified_json")?),
        tool_name: row.get("tool_name")?,
        tool_call_id: row.get("tool_call_id")?,
        source: row.get("source")?,
        generated_by_model: row.get("generated_by_model")?,
        content_hash: row.get("content_hash")?,
        created_at_epoch: row
            .get::<_, i64>("created_at_epoch")?
            .try_into()
            .unwrap_or_default(),
        hidden_at_epoch: row
            .get::<_, Option<i64>>("hidden_at_epoch")?
            .and_then(|n| u64::try_from(n).ok()),
    })
}

fn row_to_source(row: &Row<'_>) -> rusqlite::Result<MemorySource> {
    Ok(MemorySource {
        id: row.get("id")?,
        memory_kind: row.get("memory_kind")?,
        memory_id: row.get("memory_id")?,
        source_type: row.get("source_type")?,
        source_ref: row.get("source_ref")?,
        metadata_json: row.get("metadata_json")?,
        created_at_epoch: row
            .get::<_, i64>("created_at_epoch")?
            .try_into()
            .unwrap_or_default(),
    })
}

fn row_to_summary(row: &Row<'_>) -> rusqlite::Result<MemorySummary> {
    Ok(MemorySummary {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        project_key: row.get("project_key")?,
        prompt_number: row
            .get::<_, Option<i64>>("prompt_number")?
            .and_then(|n| u64::try_from(n).ok()),
        request: row.get("request")?,
        investigated: row.get("investigated")?,
        learned: row.get("learned")?,
        completed: row.get("completed")?,
        next_steps: row.get("next_steps")?,
        notes: row.get("notes")?,
        created_at_epoch: row
            .get::<_, i64>("created_at_epoch")?
            .try_into()
            .unwrap_or_default(),
        hidden_at_epoch: row
            .get::<_, Option<i64>>("hidden_at_epoch")?
            .and_then(|n| u64::try_from(n).ok()),
    })
}

fn collect_rows<T, F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<T>>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn parse_json_array(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn u64_to_i64_saturating(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn fts_query(query: &str) -> String {
    query
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
        .filter(|token| token.chars().count() > 1)
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn observation_hash(
    project_key: &str,
    observation_type: &str,
    title: Option<&str>,
    narrative: Option<&str>,
    files_modified: &[String],
) -> String {
    stable_hash_hex(&(
        project_key,
        observation_type,
        title.unwrap_or("").trim(),
        narrative.unwrap_or("").trim(),
        files_modified,
    ))
}

pub(crate) fn legacy_import_content_hash(project_key: &str, category: &str, fact: &str) -> String {
    let normalized_fact = fact
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    format!(
        "legacy-import:{}",
        stable_hash_hex(&(project_key, category, normalized_fact))
    )
}

fn stable_hash_hex<T: Hash>(value: &T) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut writer = Fnva64Writer(&mut hash);
    value.hash(&mut writer);
    format!("{hash:016x}")
}

struct Fnva64Writer<'a>(&'a mut u64);

impl std::hash::Hasher for Fnva64Writer<'_> {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            *self.0 ^= u64::from(*byte);
            *self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish(&self) -> u64 {
        *self.0
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(title: &str) -> MemoryObservationInput {
        MemoryObservationInput {
            session_id: "session-1".to_string(),
            project_key: "project-a".to_string(),
            prompt_number: Some(1),
            observation_type: "bugfix".to_string(),
            title: Some(title.to_string()),
            subtitle: Some("Edit now rejects stale writes".to_string()),
            narrative: Some(
                "The edit tool compares current content with the latest read snapshot before writing."
                    .to_string(),
            ),
            facts: vec![
                "Edit validates file snapshots before applying writes.".to_string(),
                "Stale writes return a tool error.".to_string(),
            ],
            concepts: vec!["problem-solution".to_string(), "gotcha".to_string()],
            files_read: vec!["crates/kcoder_tools/src/edit.rs".to_string()],
            files_modified: vec!["crates/kcoder_tools/src/edit.rs".to_string()],
            tool_name: Some("edit".to_string()),
            tool_call_id: Some("tool-1".to_string()),
            source: "tool_observation".to_string(),
            generated_by_model: Some("test-model".to_string()),
            created_at_epoch: 1_000,
            content_hash: None,
        }
    }

    #[test]
    fn structured_store_inserts_and_gets_observation() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        store
            .upsert_session(&MemorySessionInput {
                session_id: "session-1".to_string(),
                project_key: "project-a".to_string(),
                cwd: "/tmp/project-a".to_string(),
                started_at_epoch: 900,
            })
            .unwrap();
        store
            .save_prompt(&MemoryPromptInput {
                session_id: "session-1".to_string(),
                prompt_number: 1,
                prompt_text: "fix stale edit writes".to_string(),
                created_at_epoch: 950,
            })
            .unwrap();
        let session = store.get_session("session-1").unwrap().unwrap();
        assert_eq!(session.project_key, "project-a");
        assert_eq!(session.cwd, "/tmp/project-a");
        let prompt = store.get_prompt("session-1", 1).unwrap().unwrap();
        assert_eq!(prompt.prompt_text, "fix stale edit writes");

        let id = store
            .insert_observation(&observation("Fixed stale edit guard"))
            .unwrap();
        let row = store.get_observation(id).unwrap().unwrap();

        assert_eq!(row.title.as_deref(), Some("Fixed stale edit guard"));
        assert_eq!(row.observation_type, "bugfix");
        assert_eq!(row.facts.len(), 2);
        assert_eq!(row.files_modified, vec!["crates/kcoder_tools/src/edit.rs"]);
    }

    #[test]
    fn structured_store_dedupes_by_content_hash() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let first = store
            .insert_observation(&observation("Fixed stale edit guard"))
            .unwrap();
        let second = store
            .insert_observation(&observation("Fixed stale edit guard"))
            .unwrap();

        assert_eq!(first, second);
        let rows = store
            .search_observations(None, &MemorySearchOptions::default())
            .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn structured_store_searches_fts_and_filters() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let stale = observation("Fixed stale edit guard");
        store.insert_observation(&stale).unwrap();

        let mut other = observation("Added memory timeline tool");
        other.observation_type = "feature".to_string();
        other.project_key = "project-b".to_string();
        other.narrative =
            Some("Memory timeline can show observations around an anchor.".to_string());
        other.concepts = vec!["pattern".to_string()];
        other.files_modified = vec!["crates/kcoder_tools/src/memory_context.rs".to_string()];
        store.insert_observation(&other).unwrap();

        let results = store
            .search_observations(
                Some("stale edit"),
                &MemorySearchOptions {
                    project_key: Some("project-a".to_string()),
                    order_by: MemoryOrderBy::Relevance,
                    ..MemorySearchOptions::default()
                },
            )
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title.as_deref(), Some("Fixed stale edit guard"));

        let concept_results = store
            .search_observations(
                None,
                &MemorySearchOptions {
                    concepts: vec!["pattern".to_string()],
                    files: vec!["memory_context".to_string()],
                    ..MemorySearchOptions::default()
                },
            )
            .unwrap();

        assert_eq!(concept_results.len(), 1);
        assert_eq!(concept_results[0].observation_type, "feature");
    }

    #[test]
    fn structured_store_records_sources() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let id = store
            .insert_observation(&observation("Fixed stale edit guard"))
            .unwrap();
        let source_id = store
            .add_source(&MemorySourceInput {
                memory_kind: "observation".to_string(),
                memory_id: id,
                source_type: "tool_observation".to_string(),
                source_ref: Some("tool-1".to_string()),
                metadata_json: "{}".to_string(),
                created_at_epoch: 1_001,
            })
            .unwrap();

        assert!(source_id > 0);
        let sources = store.sources_for_memory("observation", id).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_type, "tool_observation");
        assert_eq!(sources[0].source_ref.as_deref(), Some("tool-1"));
    }

    #[test]
    fn structured_store_records_and_lists_summaries() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let id = store
            .insert_summary(&MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: "project-a".to_string(),
                prompt_number: Some(3),
                request: Some("wire memory summary".to_string()),
                investigated: Some("checked compaction path".to_string()),
                learned: Some("summary table already exists".to_string()),
                completed: Some("added summary API".to_string()),
                next_steps: Some("connect compaction".to_string()),
                notes: None,
                created_at_epoch: 2_000,
            })
            .unwrap();
        store
            .insert_summary(&MemorySummaryInput {
                session_id: "session-2".to_string(),
                project_key: "project-b".to_string(),
                prompt_number: Some(1),
                request: Some("unrelated session".to_string()),
                investigated: Some("checked different project".to_string()),
                learned: Some("summary search must honor project filters".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 2_100,
            })
            .unwrap();

        let summary = store.get_summary(id).unwrap().unwrap();
        assert_eq!(summary.prompt_number, Some(3));
        assert_eq!(summary.completed.as_deref(), Some("added summary API"));

        let summaries = store.summaries_for_session("session-1", 10).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, id);

        let searched = store
            .search_summaries(
                Some("compaction"),
                &MemorySummarySearchOptions {
                    project_key: Some("project-a".to_string()),
                    order_by: MemoryOrderBy::Relevance,
                    ..MemorySummarySearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(searched.len(), 1);
        assert_eq!(searched[0].id, id);

        let session_filtered = store
            .search_summaries(
                None,
                &MemorySummarySearchOptions {
                    session_id: Some("session-2".to_string()),
                    ..MemorySummarySearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(session_filtered.len(), 1);
        assert_eq!(session_filtered[0].project_key, "project-b");
    }

    #[test]
    fn structured_store_hides_and_restores_observations_and_summaries() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let mut first = observation("First memory");
        first.created_at_epoch = 1_000;
        let first_id = store.insert_observation(&first).unwrap();

        let mut second = observation("Second memory");
        second.created_at_epoch = 1_001;
        let second_id = store.insert_observation(&second).unwrap();

        let mut third = observation("Third memory");
        third.created_at_epoch = 1_002;
        let third_id = store.insert_observation(&third).unwrap();

        assert!(
            store
                .set_observation_hidden(second_id, Some(1_500))
                .unwrap()
        );
        assert!(store.get_observation(second_id).unwrap().is_none());
        let hidden_observations = store.hidden_observations(Some("project-a"), 10).unwrap();
        assert_eq!(hidden_observations.len(), 1);
        assert_eq!(hidden_observations[0].id, second_id);
        assert_eq!(hidden_observations[0].hidden_at_epoch, Some(1_500));
        let search = store
            .search_observations(Some("Second"), &MemorySearchOptions::default())
            .unwrap();
        assert!(search.is_empty());
        let timeline = store.timeline_around_observation(first_id, 0, 3).unwrap();
        assert_eq!(
            timeline.iter().map(|obs| obs.id).collect::<Vec<_>>(),
            vec![first_id, third_id]
        );

        assert!(store.set_observation_hidden(second_id, None).unwrap());
        assert_eq!(
            store.get_observation(second_id).unwrap().unwrap().id,
            second_id
        );
        assert!(
            store
                .hidden_observations(Some("project-a"), 10)
                .unwrap()
                .is_empty()
        );

        let summary_id = store
            .insert_summary(&MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: "project-a".to_string(),
                prompt_number: Some(1),
                request: Some("hide summary".to_string()),
                investigated: None,
                learned: Some("hidden summaries should not be retrieved".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 2_000,
            })
            .unwrap();

        assert!(store.set_summary_hidden(summary_id, Some(2_500)).unwrap());
        assert!(store.get_summary(summary_id).unwrap().is_none());
        let hidden_summaries = store.hidden_summaries(Some("project-a"), 10).unwrap();
        assert_eq!(hidden_summaries.len(), 1);
        assert_eq!(hidden_summaries[0].id, summary_id);
        assert_eq!(hidden_summaries[0].hidden_at_epoch, Some(2_500));
        assert!(
            store
                .summaries_for_session("session-1", 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .summaries_for_project("project-a", 10)
                .unwrap()
                .is_empty()
        );
        let summaries = store
            .search_summaries(
                Some("hidden summaries"),
                &MemorySummarySearchOptions::default(),
            )
            .unwrap();
        assert!(summaries.is_empty());

        assert!(store.set_summary_hidden(summary_id, None).unwrap());
        assert_eq!(
            store.get_summary(summary_id).unwrap().unwrap().id,
            summary_id
        );
        assert!(
            store
                .hidden_summaries(Some("project-a"), 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn structured_store_saturates_large_summary_timestamps() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let id = store
            .insert_summary(&MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: "project-a".to_string(),
                prompt_number: Some(u64::MAX),
                request: Some("large timestamp".to_string()),
                investigated: None,
                learned: None,
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: u64::MAX,
            })
            .unwrap();

        let summary = store.get_summary(id).unwrap().unwrap();
        assert_eq!(summary.prompt_number, Some(i64::MAX as u64));
        assert_eq!(summary.created_at_epoch, i64::MAX as u64);
    }

    #[test]
    fn structured_store_returns_timeline_around_observation() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let mut first = observation("First memory");
        first.created_at_epoch = 1_000;
        let first_id = store.insert_observation(&first).unwrap();

        let mut second = observation("Second memory");
        second.created_at_epoch = 1_001;
        let second_id = store.insert_observation(&second).unwrap();

        let mut third = observation("Third memory");
        third.created_at_epoch = 1_002;
        let third_id = store.insert_observation(&third).unwrap();

        let timeline = store.timeline_around_observation(second_id, 1, 1).unwrap();

        assert_eq!(
            timeline.iter().map(|obs| obs.id).collect::<Vec<_>>(),
            vec![first_id, second_id, third_id]
        );
    }

    #[test]
    fn project_key_migration_rolls_back_every_table_when_a_late_update_fails() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        store
            .connection()
            .execute_batch(
                r#"
                INSERT INTO memory_sessions
                    (session_id, project_key, cwd, started_at_epoch, status)
                VALUES ('legacy-session', 'legacy', '/repo', 1, 'active');
                INSERT INTO memory_observations
                    (session_id, project_key, type, source, content_hash, created_at_epoch)
                VALUES ('legacy-session', 'legacy', 'note', 'manual', 'legacy-hash', 1);
                INSERT INTO memory_summaries
                    (session_id, project_key, created_at_epoch)
                VALUES ('legacy-session', 'legacy', 1);
                CREATE TRIGGER reject_summary_project_migration
                BEFORE UPDATE OF project_key ON memory_summaries
                WHEN new.project_key = 'current'
                BEGIN
                    SELECT RAISE(ABORT, 'injected migration failure');
                END;
                "#,
            )
            .unwrap();

        assert!(store.migrate_project_key("legacy", "current").is_err());

        for table in ["memory_sessions", "memory_observations", "memory_summaries"] {
            let legacy_count: i64 = store
                .connection()
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE project_key = 'legacy'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                legacy_count, 1,
                "{table} must roll back when a later table conflicts"
            );
        }
    }

    #[test]
    fn project_key_migration_merges_duplicate_observations_and_preserves_sources() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let mut legacy = observation("Same production observation");
        legacy.project_key = "legacy".to_string();
        let legacy_id = store.insert_observation(&legacy).unwrap();
        let mut current = legacy.clone();
        current.project_key = "current".to_string();
        current.session_id = "current-session".to_string();
        let current_id = store.insert_observation(&current).unwrap();
        assert_ne!(legacy_id, current_id);

        store
            .add_source(&MemorySourceInput {
                memory_kind: "observation".to_string(),
                memory_id: legacy_id,
                source_type: "tool_observation".to_string(),
                source_ref: None,
                metadata_json: "{}".to_string(),
                created_at_epoch: 3,
            })
            .unwrap();

        assert_eq!(store.migrate_project_key("legacy", "current").unwrap(), 1);

        let observations: (i64, i64) = store
            .connection()
            .query_row(
                "SELECT COUNT(*), MIN(id) FROM memory_observations",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(observations, (1, current_id));
        let source_memory_id: i64 = store
            .connection()
            .query_row("SELECT memory_id FROM memory_sources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(source_memory_id, current_id);
        assert_eq!(
            store.insert_observation(&current).unwrap(),
            current_id,
            "a later production insert must reuse the migrated current-key hash"
        );
    }

    #[test]
    fn project_key_migration_rehashes_legacy_import_observations() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let make_input = |project_key: &str| MemoryObservationInput {
            session_id: "legacy-import".to_string(),
            project_key: project_key.to_string(),
            prompt_number: None,
            observation_type: "legacy_memory".to_string(),
            title: Some("Legacy preference memory".to_string()),
            subtitle: None,
            narrative: Some("Prefers Rust for systems work".to_string()),
            facts: vec!["Prefers Rust for systems work".to_string()],
            concepts: vec!["legacy-import".to_string(), "preference".to_string()],
            files_read: Vec::new(),
            files_modified: Vec::new(),
            tool_name: None,
            tool_call_id: None,
            source: "legacy_import".to_string(),
            generated_by_model: None,
            created_at_epoch: 1,
            content_hash: Some(legacy_import_content_hash(
                project_key,
                "preference",
                "Prefers Rust for systems work",
            )),
        };
        let legacy_id = store.insert_observation(&make_input("legacy")).unwrap();

        assert_eq!(store.migrate_project_key("legacy", "current").unwrap(), 1);
        assert_eq!(
            store.insert_observation(&make_input("current")).unwrap(),
            legacy_id,
            "legacy-import hashes must be regenerated with the current project key"
        );
    }

    #[test]
    fn project_key_migration_preserves_custom_observation_hashes() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        let mut input = observation("Custom identity observation");
        input.project_key = "legacy".to_string();
        input.content_hash = Some("caller-owned-stable-id".to_string());
        let id = store.insert_observation(&input).unwrap();

        assert_eq!(store.migrate_project_key("legacy", "current").unwrap(), 1);
        input.project_key = "current".to_string();
        assert_eq!(
            store.insert_observation(&input).unwrap(),
            id,
            "migration must not rewrite a caller-defined content hash"
        );
    }

    #[test]
    fn project_key_migration_commits_all_tables_together() {
        let store = StructuredMemoryStore::in_memory().unwrap();
        store
            .connection()
            .execute_batch(
                r#"
                INSERT INTO memory_sessions
                    (session_id, project_key, cwd, started_at_epoch, status)
                VALUES ('legacy-session', 'legacy', '/repo', 1, 'active');
                INSERT INTO memory_observations
                    (session_id, project_key, type, source, content_hash, created_at_epoch)
                VALUES ('legacy-session', 'legacy', 'note', 'manual', 'hash', 1);
                INSERT INTO memory_summaries
                    (session_id, project_key, created_at_epoch)
                VALUES ('legacy-session', 'legacy', 1);
                "#,
            )
            .unwrap();

        assert_eq!(store.migrate_project_key("legacy", "current").unwrap(), 3);
        for table in ["memory_sessions", "memory_observations", "memory_summaries"] {
            let keys: (i64, i64) = store
                .connection()
                .query_row(
                    &format!(
                        "SELECT
                            SUM(project_key = 'legacy'),
                            SUM(project_key = 'current')
                         FROM {table}"
                    ),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(keys, (0, 1), "{table} must be fully migrated");
        }
    }
}
