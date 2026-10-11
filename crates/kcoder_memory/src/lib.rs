use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tracing::{debug, warn};

mod global_revision;
pub mod manager;
mod markdown_header;
pub mod observer;
pub mod paths;
pub mod retrieval;
pub mod sqlite;
use global_revision::Revision;

pub use manager::{
    LegacyMemoryImportReport, LegacyMemoryImportStatus, MemoryManager, StructuredMemoryStats,
};
pub use observer::{
    MEMORY_OBSERVER_SCHEMA_VERSION, MemoryObserverCompactionSummary, MemoryObserverCountedField,
    MemoryObserverDraft, MemoryObserverDraftAudit, MemoryObserverDraftValidationIssue,
    MemoryObserverEvent, MemoryObserverEventBundle, MemoryObserverEventType,
    MemoryObserverFileChange, MemoryObserverObservationCandidate, MemoryObserverObservationWrite,
    MemoryObserverPrompt, MemoryObserverQueue, MemoryObserverQueueConfig,
    MemoryObserverQueueOverflowPolicy, MemoryObserverQueueStats, MemoryObserverQueueSubmitResult,
    MemoryObserverRecovery, MemoryObserverSanitizationAudit, MemoryObserverSanitizationOptions,
    MemoryObserverSkipReason, MemoryObserverStructuredWrites, MemoryObserverSummaryCandidate,
    MemoryObserverSummaryWrite, MemoryObserverVerification, deterministic_memory_observer_draft,
    memory_observer_draft_to_structured_writes, memory_observer_draft_validation_issues,
    memory_observer_output_schema, validate_memory_observer_draft,
};
pub use paths::{
    global_memory_path, legacy_project_key_for_path, previous_project_key_for_path,
    project_key_for_path, project_memory_dir,
};
pub use retrieval::{MemoryMatch, SearchRanker};
pub use sqlite::{
    MemoryObservation, MemoryObservationInput, MemoryOrderBy, MemoryPrompt, MemoryPromptInput,
    MemorySearchOptions, MemorySession, MemorySessionInput, MemorySource, MemorySourceInput,
    MemorySummary, MemorySummaryInput, MemorySummarySearchOptions, StructuredMemoryStore,
};

/// A single memory fact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub fact: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub source: String,
}

fn default_category() -> String {
    "general".to_string()
}

pub fn sanitize_memory_text(text: &str) -> Option<String> {
    const OPEN: &[u8] = b"<private>";
    const CLOSE: &[u8] = b"</private>";
    let bytes = text.as_bytes();
    let mut output = String::new();
    let mut visible_start = 0;
    let mut cursor = 0;
    let mut depth = 0usize;
    // Fixed ASCII tags make every byte visit bounded. Slicing the original
    // UTF-8 text happens only at ASCII tag boundaries, never inside a character.
    while cursor < bytes.len() {
        if bytes
            .get(cursor..cursor + OPEN.len())
            .is_some_and(|tag| tag.eq_ignore_ascii_case(OPEN))
        {
            if depth == 0 {
                output.push_str(&text[visible_start..cursor]);
            }
            depth += 1;
            cursor += OPEN.len();
        } else if depth > 0
            && bytes
                .get(cursor..cursor + CLOSE.len())
                .is_some_and(|tag| tag.eq_ignore_ascii_case(CLOSE))
        {
            depth -= 1;
            cursor += CLOSE.len();
            if depth == 0 {
                visible_start = cursor;
            }
        } else {
            cursor += 1;
        }
    }
    if depth == 0 {
        output.push_str(&text[visible_start..]);
    }
    let mut normalized = String::new();
    for word in output.split_whitespace() {
        if !normalized.is_empty() {
            normalized.push(' ');
        }
        normalized.push_str(word);
    }
    (!normalized.is_empty()).then_some(normalized)
}

fn recover_read_lock<'a, T>(lock: &'a RwLock<T>, name: &str) -> std::sync::RwLockReadGuard<'a, T> {
    match lock.read() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!(lock = name, "recovering poisoned read lock");
            poisoned.into_inner()
        }
    }
}

fn recover_write_lock<'a, T>(
    lock: &'a RwLock<T>,
    name: &str,
) -> std::sync::RwLockWriteGuard<'a, T> {
    match lock.write() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!(lock = name, "recovering poisoned write lock");
            poisoned.into_inner()
        }
    }
}

fn read_memories_from_path(path: &Path) -> Result<Vec<Memory>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read memories from {:?}", path));
        }
    };
    serde_json::from_str(&content)
        .with_context(|| format!("failed to parse memories from {:?}", path))
}

fn read_initial_memories(path: &Path) -> Result<(Vec<Memory>, Option<Revision>)> {
    let before = Revision::read(path)?;
    let memories = read_memories_from_path(path)?;
    let after = Revision::read(path)?;
    let revision = (before == after && after.cacheable()).then_some(after);
    Ok((memories, revision))
}

/// Cross-process advisory lock guarding read-modify-write cycles on shared
/// files (memory store, skill usage telemetry). The OS releases the lock when
/// a process exits, so a long-running live holder cannot be mistaken for a
/// stale sentinel and killed processes cannot wedge future writers.
pub struct MemoryFileLock {
    file: File,
}

impl MemoryFileLock {
    pub fn acquire(data_path: &Path) -> Result<Self> {
        const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
        Self::acquire_with_timeout(data_path, LOCK_TIMEOUT)
    }

    fn acquire_with_timeout(data_path: &Path, timeout: Duration) -> Result<Self> {
        let lock_path = memory_lock_path(data_path);
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create memory lock dir {:?}", parent))?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("failed to open memory lock {:?}", lock_path))?;

        let started = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(Self { file }),
                Err(error) if is_lock_contention(&error) => {
                    if started.elapsed() >= timeout {
                        anyhow::bail!("timed out waiting for memory file lock {:?}", lock_path);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to acquire memory lock {:?}", lock_path));
                }
            }
        }
    }
}

fn is_lock_contention(error: &io::Error) -> bool {
    if error.kind() == ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION are returned by
        // LockFileEx contention, but older Rust versions classify them as
        // Uncategorized instead of WouldBlock.
        error.kind() == ErrorKind::PermissionDenied || matches!(error.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

impl Drop for MemoryFileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn memory_lock_path(data_path: &Path) -> PathBuf {
    let mut path = data_path.to_path_buf();
    let extension = data_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!("{ext}.lock"))
        .unwrap_or_else(|| "lock".to_string());
    path.set_extension(extension);
    path
}

/// Global JSON-backed memory store.
#[derive(Debug)]
pub struct MemoryStore {
    inner: Arc<RwLock<MemoryStoreInner>>,
}

#[derive(Debug)]
struct MemoryStoreInner {
    memories: Vec<Memory>,
    path: PathBuf,
    revision: Option<Revision>,
    generation: u64,
    refresh_enabled: bool,
}

impl Clone for MemoryStore {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl MemoryStore {
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let (memories, revision) = read_initial_memories(&path).unwrap_or_else(|error| {
            warn!("failed to initialize memories: {error}");
            (Vec::new(), None)
        });
        Self {
            inner: Arc::new(RwLock::new(MemoryStoreInner {
                memories,
                path,
                revision,
                generation: 0,
                refresh_enabled: true,
            })),
        }
    }

    pub fn load() -> Result<Self> {
        let path = global_memory_path()?;
        if !path.exists() {
            debug!("memories file not found at {:?}, starting fresh", path);
        }
        let (memories, revision) = read_initial_memories(&path)?;

        Ok(Self {
            inner: Arc::new(RwLock::new(MemoryStoreInner {
                memories,
                path,
                revision,
                generation: 0,
                refresh_enabled: true,
            })),
        })
    }

    pub fn empty() -> Self {
        let path = global_memory_path().unwrap_or_else(|_| PathBuf::from("memories.json"));
        Self {
            inner: Arc::new(RwLock::new(MemoryStoreInner {
                memories: Vec::new(),
                path,
                revision: None,
                generation: 0,
                // Explicitly empty stores remain detached until a successful add.
                refresh_enabled: false,
            })),
        }
    }

    pub fn add(
        &self,
        category: impl Into<String>,
        fact: impl Into<String>,
        source: impl Into<String>,
    ) -> Result<()> {
        let category = category.into();
        let fact = match sanitize_memory_text(&fact.into()) {
            Some(fact) => fact,
            None => return Ok(()),
        };
        let source = source.into();
        let path = recover_read_lock(&self.inner, "memory_store").path.clone();
        let _lock = MemoryFileLock::acquire(&path)?;
        let mut inner = recover_write_lock(&self.inner, "memory_store");
        // A disk-read failure is not empty history; replace the in-memory view only after persistence succeeds.
        let mut candidate = MemoryStoreInner {
            memories: read_memories_from_path(&inner.path)?,
            path: inner.path.clone(),
            revision: None,
            generation: 0,
            refresh_enabled: true,
        };
        candidate.memories.push(Memory {
            fact,
            category,
            created_at: now_secs(),
            source,
        });
        Self::save_locked(&candidate)?;
        inner.memories = candidate.memories;
        // Only a checked read can pair cached contents with a file revision.
        // An external editor may replace the file immediately after publication.
        inner.revision = None;
        inner.generation = inner.generation.wrapping_add(1);
        inner.refresh_enabled = true;
        Ok(())
    }

    pub fn list(&self) -> Vec<Memory> {
        self.refresh_with(read_memories_from_path);
        recover_read_lock(&self.inner, "memory_store")
            .memories
            .clone()
    }

    pub fn to_prompt_text(&self, limit: usize) -> String {
        self.refresh_with(read_memories_from_path);
        let inner = recover_read_lock(&self.inner, "memory_store");
        if inner.memories.is_empty() {
            return String::new();
        }
        let mut lines = vec!["# Memories".to_string()];
        for m in inner.memories.iter().rev().take(limit) {
            lines.push(format!("- [{}] {}", m.category, m.fact));
        }
        lines.join("\n")
    }

    fn refresh_with(&self, read: impl FnOnce(&Path) -> Result<Vec<Memory>>) {
        let (path, previous, generation) = {
            let inner = recover_read_lock(&self.inner, "memory_store");
            if !inner.refresh_enabled {
                return;
            }
            (inner.path.clone(), inner.revision.clone(), inner.generation)
        };
        // Stat/read/stat happens outside cache locks. Unknown and missing are
        // distinct, so a missing-file cache still notices subsequent creation.
        let refreshed = (|| -> Result<Option<(Vec<Memory>, Revision)>> {
            let before = Revision::read(&path)?;
            if before.cacheable() && previous.as_ref() == Some(&before) {
                return Ok(None);
            }
            let memories = read(&path)?;
            let after = Revision::read(&path)?;
            if before != after {
                return Ok(None);
            }
            Ok(Some((memories, after)))
        })();
        match refreshed {
            Ok(Some((memories, revision))) => {
                let mut inner = recover_write_lock(&self.inner, "memory_store");
                if inner.generation != generation {
                    return;
                }
                inner.memories = memories;
                inner.revision = revision.cacheable().then_some(revision);
                inner.generation = inner.generation.wrapping_add(1);
            }
            Ok(None) => {}
            Err(error) => warn!("failed to refresh memories; retaining last valid view: {error}"),
        }
    }

    fn save_locked(inner: &MemoryStoreInner) -> Result<()> {
        let absolute =
            std::path::absolute(&inner.path).context("failed to resolve memories path")?;
        let parent = absolute.parent().context("memories path has no parent")?;
        let name = absolute
            .file_name()
            .context("memories path has no file name")?;
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create memories dir {:?}", parent))?;
        let content = serde_json::to_string_pretty(&inner.memories)
            .context("failed to serialize memories")?;
        // Reuse handle-relative unique temporary-file writes without changing permissions on an existing parent directory.
        kcoder_config::PrivateDirectory::open_existing(parent)?
            .atomic_replace(name, content.as_bytes())
            .with_context(|| format!("failed to persist memories to {:?}", inner.path))
    }
}

/// Append a memory to a project memory directory as a markdown file.
pub fn append_project_memory(
    dir: &Path,
    category: &str,
    fact: &str,
    source: &str,
) -> Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let file_name = sanitize_filename(&format!("{}_{}", category, fact));
    let prefix = file_name.chars().take(96).collect::<String>();
    let hash = stable_hash_hex(&(category, fact, source));
    let path = dir.join(format!("{prefix}_{hash}.md"));
    let header = markdown_header::encode(category, now_secs(), source)?;
    let content = format!("{header}\n{fact}\n");
    kcoder_config::PrivateDirectory::open_existing(dir)?.atomic_replace(
        path.file_name()
            .context("project memory path has no file name")?,
        content.as_bytes(),
    )?;
    Ok(path)
}

fn sanitize_filename(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
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
            *self.0 = (*self.0).wrapping_mul(0x100000001b3);
        }
    }

    fn finish(&self) -> u64 {
        *self.0
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use tempfile::TempDir;

    #[test]
    fn global_reader_initialized_before_the_file_observes_external_add() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("global.json");
        let reader = MemoryStore::with_path(&path);
        assert!(reader.list().is_empty());
        MemoryStore::with_path(&path)
            .add("user", "external note", "manual")
            .unwrap();
        assert_eq!(reader.list()[0].fact, "external note");
        assert!(reader.to_prompt_text(5).contains("external note"));
    }

    #[test]
    fn global_warm_reader_observes_external_add_edit_and_delete() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("global.json");
        let writer = MemoryStore::with_path(&path);
        writer.add("user", "original note", "manual").unwrap();
        let reader = MemoryStore::with_path(&path);
        assert_eq!(reader.list().len(), 1);
        writer.add("user", "second note", "manual").unwrap();
        assert_eq!(reader.list().len(), 2);
        let memories = vec![Memory {
            fact: "manual edited note".into(),
            category: "user".into(),
            created_at: 1,
            source: "manual".into(),
        }];
        fs::write(&path, serde_json::to_vec(&memories).unwrap()).unwrap();
        assert!(reader.to_prompt_text(5).contains("manual edited note"));
        assert!(!reader.to_prompt_text(5).contains("original note"));
        fs::remove_file(&path).unwrap();
        assert!(reader.list().is_empty());
        assert!(reader.to_prompt_text(5).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn global_reader_detects_same_length_replacement_with_restored_mtime() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("global.json");
        let writer = MemoryStore::with_path(&path);
        writer.add("user", "original note", "manual").unwrap();
        let reader = MemoryStore::with_path(&path);
        assert_eq!(reader.list()[0].fact, "original note");
        let original = fs::read_to_string(&path).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let replacement = tmp.path().join("replacement.tmp");
        let changed = original.replace("original note", "replaced note");
        assert_eq!(changed.len(), original.len());
        fs::write(&replacement, changed).unwrap();
        File::open(&replacement)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_eq!(reader.list()[0].fact, "replaced note");
    }

    #[test]
    fn global_refresh_failures_preserve_last_good_view_and_bad_disk_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("global.json");
        let store = MemoryStore::with_path(&path);
        store.add("user", "known note", "manual").unwrap();
        assert_eq!(store.list()[0].fact, "known note");
        store.refresh_with(|_| panic!("unchanged cache must not read the whole file"));
        let broken = b"[{ invalid json";
        fs::write(&path, broken).unwrap();
        assert_eq!(store.list()[0].fact, "known note");
        assert!(store.to_prompt_text(5).contains("known note"));
        assert_eq!(fs::read(&path).unwrap(), broken);
        assert!(
            store
                .add("user", "must not overwrite corruption", "manual")
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), broken);
        let repaired = vec![Memory {
            fact: "repaired note".into(),
            category: "user".into(),
            source: "manual".into(),
            created_at: 1,
        }];
        fs::write(&path, serde_json::to_vec(&repaired).unwrap()).unwrap();
        store.refresh_with(|_| {
            Err(io::Error::new(ErrorKind::PermissionDenied, "injected read failure").into())
        });
        assert_eq!(
            recover_read_lock(&store.inner, "test").memories[0].fact,
            "known note"
        );
        assert_eq!(store.list()[0].fact, "repaired note");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(store.list()[0].fact, "repaired note");
        fs::remove_dir(&path).unwrap();
        assert!(store.list().is_empty());
    }

    #[test]
    fn global_refresh_rejects_unstable_reads_and_does_not_overwrite_a_newer_cache() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("global.json");
        let writer = MemoryStore::with_path(&path);
        writer.add("user", "initial note", "manual").unwrap();
        let reader = MemoryStore::with_path(&path);
        let old_file = File::open(&path).unwrap();
        writer.add("user", "external addition", "manual").unwrap();
        reader.refresh_with(|path| {
            let parsed = read_memories_from_path(path)?;
            writer.add("user", "changed during read", "manual")?;
            Ok(parsed)
        });
        assert_eq!(recover_read_lock(&reader.inner, "test").memories.len(), 1);
        // A second reader publishes the stable new view while the first reader
        // still holds the older opened file descriptor. The generation fence
        // prevents that late result from replacing the newer cache.
        reader.refresh_with(|_| {
            assert_eq!(reader.list().len(), 3);
            use std::io::Read;
            let mut content = String::new();
            (&old_file).read_to_string(&mut content)?;
            Ok(serde_json::from_str(&content)?)
        });
        assert_eq!(recover_read_lock(&reader.inner, "test").memories.len(), 3);
        reader.refresh_with(|_| panic!("stable latest view remains cached"));
    }

    #[test]
    fn explicitly_empty_global_store_stays_detached_until_successful_add() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("global.json");
        let writer = MemoryStore::with_path(&path);
        writer.add("user", "existing disk note", "manual").unwrap();
        let empty = MemoryStore::empty();
        recover_write_lock(&empty.inner, "test").path = path.clone();
        assert!(empty.list().is_empty());
        assert!(empty.to_prompt_text(5).is_empty());
        writer.add("user", "external new note", "manual").unwrap();
        assert!(empty.list().is_empty());
        empty
            .add("user", "explicitly joined store", "manual")
            .unwrap();
        assert_eq!(empty.list().len(), 3);
        writer.add("user", "later external note", "manual").unwrap();
        assert_eq!(empty.list().len(), 4);
    }

    #[cfg(unix)]
    #[test]
    fn project_memory_replacement_does_not_follow_a_target_symlink() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("project");
        let note = append_project_memory(&dir, "project", "fact", "auto").unwrap();
        let sentinel = tmp.path().join("external.txt");
        fs::write(&sentinel, "untouched external data").unwrap();
        fs::remove_file(&note).unwrap();
        std::os::unix::fs::symlink(&sentinel, &note).unwrap();
        append_project_memory(&dir, "project", "fact", "auto").unwrap();
        assert_eq!(
            fs::read_to_string(&sentinel).unwrap(),
            "untouched external data"
        );
        assert!(
            !fs::symlink_metadata(&note)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn sanitizer_handles_deep_private_nesting_and_unicode_boundaries() {
        let nested = format!(
            "文 {}secret{} 尾",
            "<PrIvAtE>".repeat(1024),
            "</pRiVaTe>".repeat(1024)
        );
        assert_eq!(sanitize_memory_text(&nested).as_deref(), Some("文 尾"));
        assert_eq!(
            sanitize_memory_text("文 <PRIVATE>hidden<private>more</private>"),
            Some("文".into())
        );
        assert_eq!(
            sanitize_memory_text("</private> visible"),
            Some("</private> visible".into())
        );
    }

    #[test]
    fn add_rejects_corrupt_disk_data_without_changing_memory_or_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memories.json");
        let store = MemoryStore::with_path(&path);
        store.add("user", "original", "manual").unwrap();
        let broken = b"[{\"fact\": invalid json";
        fs::write(&path, broken).unwrap();
        assert!(store.add("user", "new fact", "manual").is_err());
        assert_eq!(fs::read(&path).unwrap(), broken);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].fact, "original");
    }

    #[test]
    fn add_read_failure_preserves_in_memory_facts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memories.json");
        let store = MemoryStore::with_path(&path);
        store.add("user", "original", "manual").unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.add("user", "new fact", "manual").is_err());
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].fact, "original");
    }

    #[cfg(unix)]
    #[test]
    fn add_persist_failure_does_not_commit_candidate_to_memory() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("store");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("memories.json");
        let store = MemoryStore::with_path(&path);
        store.add("user", "original", "manual").unwrap();
        let bytes = fs::read(&path).unwrap();
        let moved = tmp.path().join("moved");
        fs::rename(&parent, &moved).unwrap();
        // Reads may still succeed, but safe writes reject a parent directory replaced by a symlink.
        std::os::unix::fs::symlink(&moved, &parent).unwrap();
        assert!(store.add("user", "new fact", "manual").is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].fact, "original");
    }

    #[cfg(unix)]
    #[test]
    fn memory_atomic_save_ignores_old_temporary_symlink_and_uses_private_mode() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memories.json");
        let sentinel = tmp.path().join("sentinel");
        fs::write(&sentinel, "untouched").unwrap();
        let old_tmp = path.with_extension("json.tmp");
        symlink(&sentinel, &old_tmp).unwrap();
        let store = MemoryStore::with_path(&path);
        store.add("user", "private fact", "manual").unwrap();
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "untouched");
        assert!(
            fs::symlink_metadata(old_tmp)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn separate_stores_sequential_adds_preserve_both_facts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memories.json");
        let first = MemoryStore::with_path(&path);
        let second = MemoryStore::with_path(&path);
        first.add("user", "first", "manual").unwrap();
        second.add("user", "second", "manual").unwrap();
        let facts = MemoryStore::with_path(&path).list();
        assert_eq!(
            facts
                .iter()
                .map(|memory| memory.fact.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[test]
    fn memory_store_adds_and_lists() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memories.json");
        let store = MemoryStore::with_path(&path);
        assert!(store.list().is_empty());
        store.add("user", "prefers Rust", "manual").unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].fact, "prefers Rust");
        assert_eq!(list[0].category, "user");
        assert!(path.exists());
    }

    #[test]
    fn memory_lock_ignores_an_unlocked_old_sentinel_file() {
        let tmp = TempDir::new().unwrap();
        let data_path = tmp.path().join("memories.json");
        std::fs::write(&data_path, "[]").unwrap();
        let lock_path = memory_lock_path(&data_path);
        std::fs::write(&lock_path, "stale").unwrap();
        // Age the sentinel well beyond the stale threshold.
        let stale_time = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&lock_path)
            .unwrap()
            .set_modified(stale_time)
            .unwrap();

        let started = std::time::Instant::now();
        let lock = MemoryFileLock::acquire(&data_path).expect("stale lock must be broken");
        drop(lock);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "a stale lock should be broken immediately, not after the 30s timeout"
        );
    }

    #[test]
    fn memory_lock_never_steals_an_old_but_live_os_lock() {
        let tmp = TempDir::new().unwrap();
        let data_path = tmp.path().join("memories.json");
        let first = MemoryFileLock::acquire(&data_path).unwrap();
        let lock_path = memory_lock_path(&data_path);
        let stale_time = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&lock_path)
            .unwrap()
            .set_modified(stale_time)
            .unwrap();

        let second =
            MemoryFileLock::acquire_with_timeout(&data_path, std::time::Duration::from_millis(100));
        assert!(
            second.is_err(),
            "mtime must not let a contender steal a live OS lock"
        );

        drop(first);
        MemoryFileLock::acquire_with_timeout(&data_path, std::time::Duration::from_millis(100))
            .expect("the OS lock must be released when its owner drops");
    }

    #[test]
    fn sanitize_memory_text_strips_private_segments() {
        assert_eq!(
            sanitize_memory_text("keep <private>secret token</private> public").as_deref(),
            Some("keep public")
        );
        assert_eq!(
            sanitize_memory_text("<PRIVATE>secret</PRIVATE>").as_deref(),
            None
        );
        assert_eq!(
            sanitize_memory_text("visible <private>unterminated secret").as_deref(),
            Some("visible")
        );
    }

    #[test]
    fn sanitize_memory_text_strips_nested_private_segments() {
        // The tail of the outer private segment must not leak.
        assert_eq!(
            sanitize_memory_text(
                "a <private>token1 <private>token2</private> still-secret</private> b"
            )
            .as_deref(),
            Some("a b")
        );
        // Nested unterminated: everything from the first tag is dropped.
        assert_eq!(
            sanitize_memory_text("a <private>x <private>y</private> z").as_deref(),
            Some("a")
        );
        // Sequential sibling segments still work.
        assert_eq!(
            sanitize_memory_text("a <private>x</private> b <private>y</private> c").as_deref(),
            Some("a b c")
        );
    }

    #[test]
    fn memory_store_skips_private_only_facts() {
        let tmp = TempDir::new().unwrap();
        let store = MemoryStore::with_path(tmp.path().join("memories.json"));

        store
            .add("user", "<private>secret token</private>", "manual")
            .unwrap();
        store
            .add("user", "use Rust <private>secret token</private>", "manual")
            .unwrap();

        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].fact, "use Rust");
    }

    #[test]
    fn memory_store_prompt_text() {
        let tmp = TempDir::new().unwrap();
        let store = MemoryStore::with_path(tmp.path().join("memories.json"));
        store.add("project", "use anyhow", "manual").unwrap();
        let text = store.to_prompt_text(10);
        assert!(text.contains("# Memories"));
        assert!(text.contains("[project] use anyhow"));
    }

    #[test]
    fn memory_store_concurrent_instances_preserve_all_writes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memories.json");
        let workers = 8;
        let barrier = Arc::new(Barrier::new(workers));

        let handles = (0..workers)
            .map(|idx| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let store = MemoryStore::with_path(path);
                    barrier.wait();
                    store
                        .add("user", format!("fact-{idx}"), "thread-test")
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().unwrap();
        }

        let mut facts = MemoryStore::with_path(&path)
            .list()
            .into_iter()
            .map(|memory| memory.fact)
            .collect::<Vec<_>>();
        facts.sort();

        assert_eq!(facts.len(), workers);
        for idx in 0..workers {
            assert!(facts.contains(&format!("fact-{idx}")));
        }
    }

    #[test]
    fn append_project_memory_creates_markdown() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("memory");
        let path = append_project_memory(&dir, "user", "likes tea", "auto").unwrap();
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("category: \"user\""));
        assert!(content.contains("likes tea"));
    }

    #[test]
    fn append_project_memory_filename_includes_full_hash_to_avoid_truncation_collision() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("memory");
        let common_prefix = "a".repeat(160);
        let first =
            append_project_memory(&dir, "project", &format!("{common_prefix}x"), "auto").unwrap();
        let second =
            append_project_memory(&dir, "project", &format!("{common_prefix}y"), "auto").unwrap();

        assert_ne!(first, second);
        for path in [first, second] {
            let stem = path.file_stem().unwrap().to_string_lossy();
            let hash = stem.rsplit('_').next().unwrap();
            assert_eq!(hash.len(), 16);
            assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
        }
    }
}
