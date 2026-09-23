use crate::sqlite::{
    MemoryObservationInput, MemoryPrompt, MemoryPromptInput, MemorySearchOptions, MemorySession,
    MemorySessionInput, MemorySource, MemorySourceInput, MemorySummarySearchOptions,
    StructuredMemoryStore, now_millis,
};
use crate::{
    Memory, MemoryObservation, MemoryStore, MemorySummary, MemorySummaryInput, SearchRanker,
    append_project_memory, legacy_project_key_for_path, previous_project_key_for_path,
    project_key_for_path, project_memory_dir, sanitize_memory_text,
};
use anyhow::Result;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use tracing::warn;
use walkdir::WalkDir;

type StructuredStoreHandle = Arc<Mutex<StructuredMemoryStore>>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LegacyMemoryImportReport {
    pub scanned: usize,
    pub imported: usize,
    pub skipped_private: usize,
    pub skipped_existing: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LegacyMemoryImportStatus {
    pub observation_id: i64,
    pub hidden: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StructuredMemoryStats {
    pub available: bool,
    pub observations_visible: usize,
    pub observations_hidden: usize,
    pub summaries_visible: usize,
    pub summaries_hidden: usize,
}

/// Central coordinator for memory storage and retrieval.
///
/// Combines a global JSON-backed store with per-project markdown memories.
#[derive(Debug, Clone)]
pub struct MemoryManager {
    global: MemoryStore,
    project_dir: Option<PathBuf>,
    project_key: Option<String>,
    structured: Option<StructuredStoreHandle>,
    /// In-memory cache of project memories loaded on first access.
    project_memories: Arc<RwLock<Vec<Memory>>>,
}

impl MemoryManager {
    /// Create a manager with an explicit project memory directory.
    pub fn with_project_dir(global: MemoryStore, project_dir: impl Into<PathBuf>) -> Self {
        Self {
            global,
            project_dir: Some(project_dir.into()),
            project_key: None,
            structured: None,
            project_memories: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Create a manager with no project directory (global-only).
    pub fn global_only(global: MemoryStore) -> Self {
        Self {
            global,
            project_dir: None,
            project_key: None,
            structured: None,
            project_memories: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Convenience constructor that resolves the project dir from cwd.
    pub fn new(global: MemoryStore, cwd: &Path, memory_base: &Path) -> Result<Self> {
        let project_dir = project_memory_dir(cwd, memory_base)?;
        let project_key = project_key_for_path(cwd);
        let db_path = memory_base.join("memory.sqlite3");
        let structured = match StructuredMemoryStore::open(&db_path) {
            Ok(store) => {
                // Re-home rows written under the pre-hash project key format.
                // Parallel sessions share this database, so a lock contention
                // gets a few bounded retries before we defer the migration.
                for legacy in [
                    previous_project_key_for_path(cwd),
                    legacy_project_key_for_path(cwd),
                ] {
                    if legacy == project_key {
                        continue;
                    }
                    let mut attempt = 0u32;
                    loop {
                        match store.migrate_project_key(&legacy, &project_key) {
                            Ok(_migrated) => break,
                            Err(error) => {
                                attempt += 1;
                                let locked = error.to_string().to_lowercase().contains("locked");
                                if !locked || attempt >= 3 {
                                    warn!("failed to migrate memory project key: {error}");
                                    break;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(
                                    100 * u64::from(attempt),
                                ));
                            }
                        }
                    }
                }
                Some(Arc::new(Mutex::new(store)))
            }
            Err(error) => {
                warn!(
                    path = %db_path.display(),
                    "failed to initialize structured memory store: {error}"
                );
                None
            }
        };
        let mut manager = Self::with_project_dir(global, project_dir);
        manager.project_key = Some(project_key);
        manager.structured = structured;
        Ok(manager)
    }

    /// Attach a structured store. Primarily used by tests and migration glue.
    pub fn with_structured_store(
        mut self,
        store: StructuredMemoryStore,
        project_key: impl Into<String>,
    ) -> Self {
        self.project_key = Some(project_key.into());
        self.structured = Some(Arc::new(Mutex::new(store)));
        self
    }

    /// Disable the structured SQLite memory layer while keeping legacy memory available.
    pub fn without_structured_store(mut self) -> Self {
        self.structured = None;
        self
    }

    /// Access the underlying global memory store.
    pub fn global_store(&self) -> MemoryStore {
        self.global.clone()
    }

    pub fn structured_memory_stats(&self) -> Result<StructuredMemoryStats> {
        let Some(store) = &self.structured else {
            return Ok(StructuredMemoryStats::default());
        };
        let store = lock_structured_store(store);
        let project_key = self.project_key.as_deref();
        Ok(StructuredMemoryStats {
            available: true,
            observations_visible: store.count_observations(project_key, Some(false))?,
            observations_hidden: store.count_observations(project_key, Some(true))?,
            summaries_visible: store.count_summaries(project_key, Some(false))?,
            summaries_hidden: store.count_summaries(project_key, Some(true))?,
        })
    }

    /// Add a user-facing memory to the global store.
    pub fn remember_user(&self, fact: &str) -> Result<()> {
        let Some(fact) = sanitize_memory_text(fact) else {
            return Ok(());
        };
        self.global.add("user", &fact, "manual")?;
        self.remember_structured_best_effort("user", &fact, "manual");
        Ok(())
    }

    /// Add a tool-created explicit memory to the legacy store and structured store.
    pub fn remember_tool(&self, category: &str, fact: &str) -> Result<()> {
        let Some(fact) = sanitize_memory_text(fact) else {
            return Ok(());
        };
        self.global.add(category, &fact, "tool")?;
        self.remember_structured_best_effort(category, &fact, "tool");
        Ok(())
    }

    /// Add an auto-extracted memory to the project directory.
    pub fn remember_auto(&self, category: &str, fact: &str) -> Result<Option<PathBuf>> {
        let Some(fact) = sanitize_memory_text(fact) else {
            return Ok(None);
        };
        let path = if let Some(dir) = &self.project_dir {
            let path = append_project_memory(dir, category, &fact, "auto")?;
            // Invalidate cache so the next retrieval sees the new memory.
            crate::recover_write_lock(&self.project_memories, "project_memories").clear();
            Some(path)
        } else {
            self.global.add(category, &fact, "auto")?;
            None
        };
        self.remember_structured_best_effort(category, &fact, "auto");
        Ok(path)
    }

    /// List all memories (global + project), newest first.
    pub fn all_memories(&self) -> Vec<Memory> {
        let mut all = self.global.list();
        all.extend(self.project_memories());
        all.sort_by_key(|memory| std::cmp::Reverse(memory.created_at));
        all
    }

    /// Search memories by query, returning the top `limit` matches.
    pub fn search(&self, query: &str, recent_tools: &[String], limit: usize) -> Vec<Memory> {
        let all = self.all_memories();
        SearchRanker::rank(&all, query, recent_tools)
            .into_iter()
            .take(limit)
            .map(|m| m.memory)
            .collect()
    }

    /// Search structured observations when the SQLite store is available.
    pub fn search_structured_observations(
        &self,
        query: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryObservation>> {
        self.search_structured_observations_with_options(
            query,
            MemorySearchOptions {
                limit: Some(limit),
                ..MemorySearchOptions::default()
            },
        )
    }

    /// Search structured observations with explicit filters.
    pub fn search_structured_observations_with_options(
        &self,
        query: Option<&str>,
        mut options: MemorySearchOptions,
    ) -> Result<Vec<MemoryObservation>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        if options.project_key.is_none() {
            options.project_key = self.project_key.clone();
        }
        lock_structured_store(store).search_observations(query, &options)
    }

    /// Import legacy JSON/markdown memories into structured SQLite observations.
    pub fn import_legacy_memories(&self) -> Result<LegacyMemoryImportReport> {
        let Some(_store) = &self.structured else {
            return Ok(LegacyMemoryImportReport::default());
        };
        let mut report = LegacyMemoryImportReport::default();
        let project_key = self
            .project_key
            .clone()
            .unwrap_or_else(|| "global".to_string());

        for memory in self.all_memories() {
            report.scanned += 1;
            let Some((content_hash, source_ref, category, legacy_source, fact)) =
                legacy_memory_import_identity(&project_key, &memory)
            else {
                report.skipped_private += 1;
                continue;
            };
            let created_at_epoch = if memory.created_at > 0 {
                memory.created_at.saturating_mul(1_000)
            } else {
                now_millis()
            };

            let observation_id = match self.save_structured_observation(MemoryObservationInput {
                session_id: "legacy-import".to_string(),
                project_key: project_key.clone(),
                prompt_number: None,
                observation_type: "legacy_memory".to_string(),
                title: Some(format!("Legacy {category} memory")),
                subtitle: None,
                narrative: Some(fact.clone()),
                facts: vec![fact.clone()],
                concepts: vec!["legacy-import".to_string(), category.clone()],
                files_read: Vec::new(),
                files_modified: Vec::new(),
                tool_name: None,
                tool_call_id: None,
                source: "legacy_import".to_string(),
                generated_by_model: None,
                created_at_epoch,
                content_hash: Some(content_hash),
            })? {
                Some(id) => id,
                None => {
                    report.skipped_private += 1;
                    continue;
                }
            };

            let sources = self.structured_sources_for_memory("observation", observation_id)?;
            if sources.iter().any(|source| {
                source.source_type == "legacy_import"
                    && source.source_ref.as_deref() == Some(source_ref.as_str())
            }) {
                report.skipped_existing += 1;
                continue;
            }

            self.save_structured_source(MemorySourceInput {
                memory_kind: "observation".to_string(),
                memory_id: observation_id,
                source_type: "legacy_import".to_string(),
                source_ref: Some(source_ref),
                metadata_json: serde_json::json!({
                    "category": category,
                    "legacy_source": legacy_source,
                    "legacy_created_at": memory.created_at,
                    "fact_chars": fact.chars().count(),
                })
                .to_string(),
                created_at_epoch: now_millis(),
            })?;
            report.imported += 1;
        }

        Ok(report)
    }

    /// Return the structured observation imported from a legacy memory, if present.
    pub fn legacy_memory_import_status(
        &self,
        memory: &Memory,
    ) -> Result<Option<LegacyMemoryImportStatus>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        let project_key = self
            .project_key
            .clone()
            .unwrap_or_else(|| "global".to_string());
        let Some((content_hash, source_ref, _, _, _)) =
            legacy_memory_import_identity(&project_key, memory)
        else {
            return Ok(None);
        };
        let store = lock_structured_store(store);
        let Some(observation) = store.observation_by_content_hash(&project_key, &content_hash)?
        else {
            return Ok(None);
        };
        let sources = store.sources_for_memory("observation", observation.id)?;
        if !sources.iter().any(|source| {
            source.source_type == "legacy_import"
                && source.source_ref.as_deref() == Some(source_ref.as_str())
        }) {
            return Ok(None);
        }
        Ok(Some(LegacyMemoryImportStatus {
            observation_id: observation.id,
            hidden: observation.hidden_at_epoch.is_some(),
        }))
    }

    /// Upsert a structured session row when the SQLite store is available.
    pub fn save_structured_session(&self, mut input: MemorySessionInput) -> Result<Option<i64>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        if input.project_key.is_empty() {
            input.project_key = self
                .project_key
                .clone()
                .unwrap_or_else(|| "global".to_string());
        }
        lock_structured_store(store)
            .upsert_session(&input)
            .map(Some)
    }

    /// Fetch one structured session row when the SQLite store is available.
    pub fn get_structured_session(&self, session_id: &str) -> Result<Option<MemorySession>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        lock_structured_store(store).get_session(session_id)
    }

    /// Mark a structured session as finished when the SQLite store is available.
    pub fn finish_structured_session(
        &self,
        session_id: &str,
        ended_at_epoch: u64,
        status: &str,
    ) -> Result<bool> {
        let Some(store) = &self.structured else {
            return Ok(false);
        };
        lock_structured_store(store).finish_session(session_id, ended_at_epoch, status)
    }

    /// Save a structured user prompt row when the SQLite store is available.
    pub fn save_structured_prompt(&self, mut input: MemoryPromptInput) -> Result<Option<i64>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        let Some(prompt_text) = sanitize_memory_text(&input.prompt_text) else {
            return Ok(None);
        };
        input.prompt_text = prompt_text;
        lock_structured_store(store).save_prompt(&input).map(Some)
    }

    /// Fetch one structured prompt row when the SQLite store is available.
    pub fn get_structured_prompt(
        &self,
        session_id: &str,
        prompt_number: u64,
    ) -> Result<Option<MemoryPrompt>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        lock_structured_store(store).get_prompt(session_id, prompt_number)
    }

    /// Save a structured observation when the SQLite store is available.
    pub fn save_structured_observation(
        &self,
        mut input: MemoryObservationInput,
    ) -> Result<Option<i64>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        if input.project_key.is_empty() {
            input.project_key = self
                .project_key
                .clone()
                .unwrap_or_else(|| "global".to_string());
        }
        sanitize_observation_input(&mut input);
        if observation_input_is_empty(&input) {
            return Ok(None);
        }
        lock_structured_store(store)
            .insert_observation(&input)
            .map(Some)
    }

    /// Save a provenance source row for a structured memory.
    pub fn save_structured_source(&self, mut input: MemorySourceInput) -> Result<Option<i64>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        input.source_ref = input
            .source_ref
            .take()
            .and_then(|value| sanitize_memory_text(&value));
        input.metadata_json = sanitize_memory_text(&input.metadata_json)
            .filter(|metadata| !metadata.trim().is_empty())
            .unwrap_or_else(|| "{}".to_string());
        lock_structured_store(store).add_source(&input).map(Some)
    }

    /// List provenance source rows for a structured memory.
    pub fn structured_sources_for_memory(
        &self,
        memory_kind: &str,
        memory_id: i64,
    ) -> Result<Vec<MemorySource>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        lock_structured_store(store).sources_for_memory(memory_kind, memory_id)
    }

    /// Fetch one structured observation by id when the SQLite store is available.
    pub fn get_structured_observation(&self, id: i64) -> Result<Option<MemoryObservation>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        lock_structured_store(store).get_observation(id)
    }

    /// Fetch one structured summary by id when the SQLite store is available.
    pub fn get_structured_summary(&self, id: i64) -> Result<Option<MemorySummary>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        lock_structured_store(store).get_summary(id)
    }

    /// Hide one structured observation from default retrieval and prompt injection.
    pub fn hide_structured_observation(&self, id: i64) -> Result<bool> {
        let Some(store) = &self.structured else {
            return Ok(false);
        };
        lock_structured_store(store).set_observation_hidden(id, Some(now_millis()))
    }

    /// Restore one hidden structured observation to default retrieval.
    pub fn restore_structured_observation(&self, id: i64) -> Result<bool> {
        let Some(store) = &self.structured else {
            return Ok(false);
        };
        lock_structured_store(store).set_observation_hidden(id, None)
    }

    /// Hide one structured summary from default retrieval and prompt injection.
    pub fn hide_structured_summary(&self, id: i64) -> Result<bool> {
        let Some(store) = &self.structured else {
            return Ok(false);
        };
        lock_structured_store(store).set_summary_hidden(id, Some(now_millis()))
    }

    /// Restore one hidden structured summary to default retrieval.
    pub fn restore_structured_summary(&self, id: i64) -> Result<bool> {
        let Some(store) = &self.structured else {
            return Ok(false);
        };
        lock_structured_store(store).set_summary_hidden(id, None)
    }

    /// List hidden structured observations for audit and restore workflows.
    pub fn hidden_structured_observations(&self, limit: usize) -> Result<Vec<MemoryObservation>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        lock_structured_store(store).hidden_observations(self.project_key.as_deref(), limit)
    }

    /// List hidden structured summaries for audit and restore workflows.
    pub fn hidden_structured_summaries(&self, limit: usize) -> Result<Vec<MemorySummary>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        lock_structured_store(store).hidden_summaries(self.project_key.as_deref(), limit)
    }

    /// Fetch a same-session structured memory timeline around an observation id.
    pub fn structured_timeline_around(
        &self,
        id: i64,
        before: usize,
        after: usize,
    ) -> Result<Vec<MemoryObservation>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        lock_structured_store(store).timeline_around_observation(id, before, after)
    }

    /// Save a structured summary when the SQLite store is available.
    pub fn save_structured_summary(&self, mut input: MemorySummaryInput) -> Result<Option<i64>> {
        let Some(store) = &self.structured else {
            return Ok(None);
        };
        sanitize_summary_input(&mut input);
        if summary_input_is_empty(&input) {
            return Ok(None);
        }
        if input.project_key.is_empty() {
            input.project_key = self
                .project_key
                .clone()
                .unwrap_or_else(|| "global".to_string());
        }
        lock_structured_store(store)
            .insert_summary(&input)
            .map(Some)
    }

    /// List structured summaries for a session when the SQLite store is available.
    pub fn structured_summaries_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<MemorySummary>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        lock_structured_store(store).summaries_for_session(session_id, limit)
    }

    /// Search structured summaries when the SQLite store is available.
    pub fn search_structured_summaries(
        &self,
        query: Option<&str>,
        mut options: MemorySummarySearchOptions,
    ) -> Result<Vec<MemorySummary>> {
        let Some(store) = &self.structured else {
            return Ok(Vec::new());
        };
        if options.project_key.is_none() {
            options.project_key = self.project_key.clone();
        }
        lock_structured_store(store).search_summaries(query, &options)
    }

    /// Format memories for injection into the system prompt.
    ///
    /// If `query` is provided, only relevant memories are returned; otherwise
    /// the most recent `limit` memories are returned.
    pub fn to_prompt_text(
        &self,
        query: Option<&str>,
        recent_tools: &[String],
        limit: usize,
    ) -> String {
        self.to_prompt_text_with_options(query, recent_tools, limit, true)
    }

    /// Format memories for prompt injection with explicit legacy fallback control.
    pub fn to_prompt_text_with_options(
        &self,
        query: Option<&str>,
        recent_tools: &[String],
        limit: usize,
        include_legacy: bool,
    ) -> String {
        let structured = self.structured_memories_for_prompt(query, limit);
        let summaries = self.structured_summaries_for_prompt(limit);
        let memories = if include_legacy {
            match query {
                Some(q) if !q.is_empty() => self.search(q, recent_tools, limit),
                _ => self.all_memories().into_iter().take(limit).collect(),
            }
        } else {
            Vec::new()
        };
        if structured.is_empty() && summaries.is_empty() && memories.is_empty() {
            return String::new();
        }
        let mut lines = vec!["# Memories".to_string()];
        let mut seen = HashSet::new();
        for observation in structured.iter().take(limit) {
            remember_observation_texts(&mut seen, observation);
            lines.push(format_observation_for_prompt(observation));
        }

        if lines.len().saturating_sub(1) >= limit {
            return lines.join("\n");
        }

        for summary in &summaries {
            remember_summary_texts(&mut seen, summary);
            lines.push(format_summary_for_prompt(summary));
            if lines.len().saturating_sub(1) >= limit {
                return lines.join("\n");
            }
        }

        for m in memories {
            let key = normalize_memory_text(&m.fact);
            if !key.is_empty() && seen.contains(&key) {
                continue;
            }
            lines.push(format!("- [{}] {}", m.category, m.fact));
            if lines.len().saturating_sub(1) >= limit {
                break;
            }
        }
        lines.join("\n")
    }

    fn project_memories(&self) -> Vec<Memory> {
        let mut cache = crate::recover_write_lock(&self.project_memories, "project_memories");
        if cache.is_empty()
            && let Some(dir) = &self.project_dir
        {
            *cache = load_project_memories(dir);
        }
        cache.clone()
    }

    fn structured_memories_for_prompt(
        &self,
        query: Option<&str>,
        limit: usize,
    ) -> Vec<MemoryObservation> {
        let Some(store) = &self.structured else {
            return Vec::new();
        };
        let query = query.map(str::trim).filter(|q| !q.is_empty());
        let options = MemorySearchOptions {
            project_key: self.project_key.clone(),
            limit: Some(limit),
            order_by: if query.is_some() {
                crate::MemoryOrderBy::Relevance
            } else {
                crate::MemoryOrderBy::DateDesc
            },
            ..MemorySearchOptions::default()
        };
        match lock_structured_store(store).search_observations(query, &options) {
            Ok(observations) => observations,
            Err(error) => {
                warn!("failed to load structured memories for prompt: {error}");
                Vec::new()
            }
        }
    }

    fn structured_summaries_for_prompt(&self, limit: usize) -> Vec<MemorySummary> {
        let Some(store) = &self.structured else {
            return Vec::new();
        };
        let project_key = self
            .project_key
            .clone()
            .unwrap_or_else(|| "global".to_string());
        match lock_structured_store(store).summaries_for_project(&project_key, limit) {
            Ok(summaries) => summaries,
            Err(error) => {
                warn!("failed to load structured summaries for prompt: {error}");
                Vec::new()
            }
        }
    }

    fn remember_structured_best_effort(&self, category: &str, fact: &str, source: &str) {
        let Some(store) = &self.structured else {
            return;
        };
        let project_key = self
            .project_key
            .clone()
            .unwrap_or_else(|| "global".to_string());
        let input = MemoryObservationInput {
            session_id: "memory-manager".to_string(),
            project_key,
            prompt_number: None,
            observation_type: category.to_string(),
            title: Some(format!("{category} memory")),
            subtitle: None,
            narrative: Some(fact.to_string()),
            facts: vec![fact.to_string()],
            concepts: vec![category.to_string()],
            files_read: Vec::new(),
            files_modified: Vec::new(),
            tool_name: (source == "tool").then(|| "remember".to_string()),
            tool_call_id: None,
            source: source.to_string(),
            generated_by_model: None,
            created_at_epoch: now_millis(),
            content_hash: None,
        };
        if let Err(error) = lock_structured_store(store).insert_observation(&input) {
            warn!("failed to write structured memory observation: {error}");
        }
    }
}

fn format_observation_for_prompt(observation: &MemoryObservation) -> String {
    let body = observation
        .narrative
        .as_deref()
        .or_else(|| observation.facts.first().map(String::as_str))
        .or(observation.title.as_deref())
        .unwrap_or("")
        .trim();
    let title = observation.title.as_deref().unwrap_or("").trim();
    let text = if !title.is_empty() && !body.is_empty() && body != title {
        format!("{title}: {body}")
    } else if !body.is_empty() {
        body.to_string()
    } else {
        "structured memory".to_string()
    };
    format!(
        "- [{}#{}] {}",
        observation.observation_type, observation.id, text
    )
}

fn format_summary_for_prompt(summary: &MemorySummary) -> String {
    let text = summary
        .learned
        .as_deref()
        .or(summary.completed.as_deref())
        .or(summary.request.as_deref())
        .or(summary.notes.as_deref())
        .unwrap_or("structured summary")
        .trim();
    format!("- [summary#{}] {}", summary.id, text)
}

fn remember_observation_texts(seen: &mut HashSet<String>, observation: &MemoryObservation) {
    if let Some(narrative) = &observation.narrative {
        let key = normalize_memory_text(narrative);
        if !key.is_empty() {
            seen.insert(key);
        }
    }
    for fact in &observation.facts {
        let key = normalize_memory_text(fact);
        if !key.is_empty() {
            seen.insert(key);
        }
    }
}

fn remember_summary_texts(seen: &mut HashSet<String>, summary: &MemorySummary) {
    for text in [
        summary.request.as_deref(),
        summary.investigated.as_deref(),
        summary.learned.as_deref(),
        summary.completed.as_deref(),
        summary.next_steps.as_deref(),
        summary.notes.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let key = normalize_memory_text(text);
        if !key.is_empty() {
            seen.insert(key);
        }
    }
}

fn normalize_memory_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn sanitize_summary_input(input: &mut MemorySummaryInput) {
    input.request = sanitize_optional(input.request.take());
    input.investigated = sanitize_optional(input.investigated.take());
    input.learned = sanitize_optional(input.learned.take());
    input.completed = sanitize_optional(input.completed.take());
    input.next_steps = sanitize_optional(input.next_steps.take());
    input.notes = sanitize_optional(input.notes.take());
}

fn sanitize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|text| sanitize_memory_text(&text))
}

fn summary_input_is_empty(input: &MemorySummaryInput) -> bool {
    input.request.is_none()
        && input.investigated.is_none()
        && input.learned.is_none()
        && input.completed.is_none()
        && input.next_steps.is_none()
        && input.notes.is_none()
}

fn sanitize_observation_input(input: &mut MemoryObservationInput) {
    input.title = sanitize_optional(input.title.take());
    input.subtitle = sanitize_optional(input.subtitle.take());
    input.narrative = sanitize_optional(input.narrative.take());
    input.facts = sanitize_text_vec(std::mem::take(&mut input.facts));
    input.concepts = sanitize_text_vec(std::mem::take(&mut input.concepts));
}

fn sanitize_text_vec(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|text| sanitize_memory_text(&text))
        .collect()
}

fn observation_input_is_empty(input: &MemoryObservationInput) -> bool {
    input.title.is_none()
        && input.subtitle.is_none()
        && input.narrative.is_none()
        && input.facts.is_empty()
        && input.concepts.is_empty()
}

fn legacy_memory_import_identity(
    project_key: &str,
    memory: &Memory,
) -> Option<(String, String, String, String, String)> {
    let fact = sanitize_memory_text(&memory.fact)?;
    let category = if memory.category.trim().is_empty() {
        "general".to_string()
    } else {
        memory.category.trim().to_string()
    };
    let legacy_source = if memory.source.trim().is_empty() {
        "legacy".to_string()
    } else {
        memory.source.trim().to_string()
    };
    let content_hash = crate::sqlite::legacy_import_content_hash(project_key, &category, &fact);
    let source_ref = legacy_memory_source_ref(&category, &fact, &legacy_source, memory.created_at);
    Some((content_hash, source_ref, category, legacy_source, fact))
}

fn legacy_memory_source_ref(category: &str, fact: &str, source: &str, created_at: u64) -> String {
    format!(
        "legacy:{}",
        stable_hash_hex(&(category, normalize_memory_text(fact), source, created_at))
    )
}

fn stable_hash_hex<T: Hash>(value: &T) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut writer = Fnva64Writer(&mut hash);
    value.hash(&mut writer);
    format!("{hash:016x}")
}

struct Fnva64Writer<'a>(&'a mut u64);

impl Hasher for Fnva64Writer<'_> {
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

fn lock_structured_store(store: &StructuredStoreHandle) -> MutexGuard<'_, StructuredMemoryStore> {
    match store.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("recovering poisoned structured memory store lock");
            poisoned.into_inner()
        }
    }
}

fn load_project_memories(dir: &Path) -> Vec<Memory> {
    let mut memories = Vec::new();
    for entry in WalkDir::new(dir).follow_links(false).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Some(mem) = parse_markdown_memory(path) {
            memories.push(mem);
        }
    }
    memories.sort_by_key(|memory| std::cmp::Reverse(memory.created_at));
    memories
}

fn parse_markdown_memory(path: &Path) -> Option<Memory> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut category = "project".to_string();
    let mut created_at = 0u64;
    let mut source = "project".to_string();
    let mut body = content.clone();

    if let Some(frontmatter) = content.strip_prefix("---")
        && let Some((fm, rest)) = frontmatter.split_once("---")
    {
        for line in fm.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(2, ':');
            let key = parts.next().map(|s| s.trim()).unwrap_or("");
            let value = parts.next().map(|s| s.trim()).unwrap_or("");
            match key {
                "category" => category = value.to_string(),
                "created_at" => created_at = value.parse().unwrap_or(0),
                "source" => source = value.to_string(),
                _ => {}
            }
        }
        body = rest.trim().to_string();
    }

    Some(Memory {
        fact: body,
        category,
        created_at,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn manager_searches_global_and_project() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let project_dir = tmp.path().join("project-memory");
        let manager = MemoryManager::with_project_dir(global, &project_dir);

        manager.remember_user("prefers Rust").unwrap();
        manager.remember_auto("project", "use anyhow").unwrap();

        let results = manager.search("Rust", &[], 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].fact, "prefers Rust");

        let results = manager.search("anyhow", &[], 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].fact, "use anyhow");
    }

    #[test]
    fn to_prompt_text_uses_query_when_present() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global);
        manager.remember_user("likes tea").unwrap();
        manager.remember_user("likes coffee").unwrap();

        let text = manager.to_prompt_text(Some("coffee"), &[], 10);
        assert!(text.contains("coffee"));
        assert!(!text.contains("tea"));
    }

    #[test]
    fn to_prompt_text_prefers_structured_memories_and_dedupes_legacy() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        manager
            .remember_tool("project", "use anyhow Context for operational errors")
            .unwrap();

        let text = manager.to_prompt_text(Some("anyhow"), &[], 10);

        assert!(text.contains("[project#"));
        assert_eq!(
            text.matches("use anyhow Context for operational errors")
                .count(),
            1
        );
    }

    #[test]
    fn to_prompt_text_can_disable_legacy_fallback() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        global
            .add("project", "legacy fallback memory", "manual")
            .unwrap();
        let manager = MemoryManager::global_only(global);

        assert!(
            manager
                .to_prompt_text(None, &[], 10)
                .contains("legacy fallback memory")
        );
        assert_eq!(
            manager.to_prompt_text_with_options(None, &[], 10, false),
            ""
        );
    }

    #[test]
    fn to_prompt_text_includes_structured_summaries_before_legacy_memories() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        manager
            .global_store()
            .add("user", "legacy user preference", "manual")
            .unwrap();
        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: None,
                request: Some("context compaction".to_string()),
                investigated: None,
                learned: Some("compaction learned important context".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 5_000,
            })
            .unwrap()
            .unwrap();

        let text = manager.to_prompt_text(None, &[], 10);

        assert!(text.contains("[summary#"));
        assert!(text.contains("compaction learned important context"));
        assert!(text.find("[summary#").unwrap() < text.find("legacy user preference").unwrap());
    }

    #[test]
    fn manager_records_structured_session_prompt_and_source() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        manager
            .save_structured_session(MemorySessionInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                cwd: tmp.path().display().to_string(),
                started_at_epoch: 1_000,
            })
            .unwrap()
            .unwrap();
        let session = manager
            .get_structured_session("session-1")
            .unwrap()
            .unwrap();
        assert_eq!(session.project_key, "project-a");

        manager
            .save_structured_prompt(MemoryPromptInput {
                session_id: "session-1".to_string(),
                prompt_number: 1,
                prompt_text: "fix memory <private>secret token</private>".to_string(),
                created_at_epoch: 1_001,
            })
            .unwrap()
            .unwrap();
        assert!(
            manager
                .save_structured_prompt(MemoryPromptInput {
                    session_id: "session-1".to_string(),
                    prompt_number: 2,
                    prompt_text: "<private>secret token</private>".to_string(),
                    created_at_epoch: 1_002,
                })
                .unwrap()
                .is_none()
        );
        let prompt = manager
            .get_structured_prompt("session-1", 1)
            .unwrap()
            .unwrap();
        assert_eq!(prompt.prompt_text, "fix memory");
        assert!(
            manager
                .get_structured_prompt("session-1", 2)
                .unwrap()
                .is_none()
        );

        let observation_id = manager
            .save_structured_observation(MemoryObservationInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("Tool changed file".to_string()),
                subtitle: None,
                narrative: Some("Tool changed src/lib.rs".to_string()),
                facts: Vec::new(),
                concepts: vec!["tool-event".to_string()],
                files_read: Vec::new(),
                files_modified: vec!["src/lib.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-1".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_003,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        manager
            .save_structured_source(MemorySourceInput {
                memory_kind: "observation".to_string(),
                memory_id: observation_id,
                source_type: "tool_call".to_string(),
                source_ref: Some("tool-1".to_string()),
                metadata_json: r#"{"note":"ok <private>secret token</private>"}"#.to_string(),
                created_at_epoch: 1_004,
            })
            .unwrap()
            .unwrap();
        let sources = manager
            .structured_sources_for_memory("observation", observation_id)
            .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_ref.as_deref(), Some("tool-1"));
        assert!(!sources[0].metadata_json.contains("secret token"));

        assert!(
            manager
                .finish_structured_session("session-1", 2_000, "ended")
                .unwrap()
        );
        let finished = manager
            .get_structured_session("session-1")
            .unwrap()
            .unwrap();
        assert_eq!(finished.status, "ended");
        assert_eq!(finished.ended_at_epoch, Some(2_000));
    }

    #[test]
    fn manager_remember_user_dual_writes_structured_observation() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        manager.remember_user("prefers Rust").unwrap();

        assert_eq!(manager.global_store().list().len(), 1);
        let observations = manager
            .search_structured_observations(Some("prefers Rust"), 10)
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].observation_type, "user");
        assert_eq!(observations[0].narrative.as_deref(), Some("prefers Rust"));
        assert_eq!(observations[0].source, "manual");
    }

    #[test]
    fn manager_remember_tool_dual_writes_structured_observation() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        manager
            .remember_tool("project", "use anyhow Context for operational errors")
            .unwrap();

        let observations = manager
            .search_structured_observations(Some("anyhow Context"), 10)
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].observation_type, "project");
        assert_eq!(observations[0].tool_name.as_deref(), Some("remember"));
        assert_eq!(observations[0].source, "tool");
    }

    #[test]
    fn manager_imports_legacy_memories_idempotently() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        global
            .add("project", "legacy build context", "manual")
            .unwrap();
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        let report = manager.import_legacy_memories().unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped_existing, 0);
        let observations = manager
            .search_structured_observations(Some("legacy build context"), 10)
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].observation_type, "legacy_memory");
        assert_eq!(observations[0].source, "legacy_import");
        assert!(
            observations[0]
                .concepts
                .contains(&"legacy-import".to_string())
        );
        let sources = manager
            .structured_sources_for_memory("observation", observations[0].id)
            .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_type, "legacy_import");
        assert!(sources[0].metadata_json.contains("legacy_source"));
        let legacy = manager.all_memories();
        let status = manager
            .legacy_memory_import_status(&legacy[0])
            .unwrap()
            .unwrap();
        assert_eq!(status.observation_id, observations[0].id);
        assert!(!status.hidden);
        assert!(
            manager
                .hide_structured_observation(observations[0].id)
                .unwrap()
        );
        let hidden_status = manager
            .legacy_memory_import_status(&legacy[0])
            .unwrap()
            .unwrap();
        assert_eq!(hidden_status.observation_id, observations[0].id);
        assert!(hidden_status.hidden);

        let second = manager.import_legacy_memories().unwrap();

        assert_eq!(second.scanned, 1);
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped_existing, 1);
        let sources = manager
            .structured_sources_for_memory("observation", observations[0].id)
            .unwrap();
        assert_eq!(sources.len(), 1);
    }

    #[test]
    fn manager_skips_private_only_memories_and_strips_private_segments() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        manager
            .remember_tool("project", "<private>secret token</private>")
            .unwrap();
        manager
            .remember_tool("project", "use Rust <private>secret token</private>")
            .unwrap();

        let legacy = manager.global_store().list();
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].fact, "use Rust");

        let observations = manager.search_structured_observations(None, 10).unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].narrative.as_deref(), Some("use Rust"));
    }

    #[test]
    fn manager_saves_structured_summaries_when_store_is_available() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        let id = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(7),
                request: Some("summarize memory work".to_string()),
                investigated: None,
                learned: Some("structured summaries can be saved".to_string()),
                completed: Some("manager wrapper added".to_string()),
                next_steps: None,
                notes: None,
                created_at_epoch: 3_000,
            })
            .unwrap()
            .unwrap();

        let summaries = manager
            .structured_summaries_for_session("session-1", 10)
            .unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, id);
        assert_eq!(summaries[0].project_key, "project-a");

        let searched = manager
            .search_structured_summaries(
                Some("structured summaries"),
                MemorySummarySearchOptions {
                    order_by: crate::MemoryOrderBy::Relevance,
                    ..MemorySummarySearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(searched.len(), 1);
        assert_eq!(searched[0].id, id);
    }

    #[test]
    fn manager_reports_structured_memory_stats() {
        let tmp = TempDir::new().unwrap();
        let unavailable =
            MemoryManager::global_only(MemoryStore::with_path(tmp.path().join("empty.json")));

        assert_eq!(
            unavailable.structured_memory_stats().unwrap(),
            StructuredMemoryStats::default()
        );

        let manager =
            MemoryManager::global_only(MemoryStore::with_path(tmp.path().join("memories.json")))
                .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        manager
            .save_structured_observation(MemoryObservationInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("visible observation".to_string()),
                subtitle: None,
                narrative: Some("visible observation".to_string()),
                facts: Vec::new(),
                concepts: Vec::new(),
                files_read: Vec::new(),
                files_modified: vec!["src/lib.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-visible".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_000,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        let hidden_observation_id = manager
            .save_structured_observation(MemoryObservationInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("hidden observation".to_string()),
                subtitle: None,
                narrative: Some("hidden observation".to_string()),
                facts: Vec::new(),
                concepts: Vec::new(),
                files_read: Vec::new(),
                files_modified: vec!["hidden.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-hidden".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_001,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        manager
            .hide_structured_observation(hidden_observation_id)
            .unwrap();
        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("visible summary".to_string()),
                investigated: None,
                learned: Some("visible summary".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_002,
            })
            .unwrap()
            .unwrap();
        let hidden_summary_id = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("hidden summary".to_string()),
                investigated: None,
                learned: Some("hidden summary".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_003,
            })
            .unwrap()
            .unwrap();
        manager.hide_structured_summary(hidden_summary_id).unwrap();

        assert_eq!(
            manager.structured_memory_stats().unwrap(),
            StructuredMemoryStats {
                available: true,
                observations_visible: 1,
                observations_hidden: 1,
                summaries_visible: 1,
                summaries_hidden: 1,
            }
        );
    }

    #[test]
    fn manager_sanitizes_structured_summaries() {
        let tmp = TempDir::new().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        let manager = MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        let skipped = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: None,
                request: Some("<private>secret</private>".to_string()),
                investigated: None,
                learned: None,
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 4_000,
            })
            .unwrap();
        assert!(skipped.is_none());

        manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: None,
                request: Some("keep <private>secret</private>".to_string()),
                investigated: None,
                learned: None,
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 4_001,
            })
            .unwrap()
            .unwrap();
        let summaries = manager
            .structured_summaries_for_session("session-1", 10)
            .unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].request.as_deref(), Some("keep"));
    }
}
