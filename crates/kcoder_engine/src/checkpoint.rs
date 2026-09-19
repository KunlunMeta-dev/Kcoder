//! Per-prompt file checkpoints and rewind.
//!
//! Before the agent mutates a file via the `write`/`edit` tools, the original
//! content is snapshotted under the session directory. Each user request (the
//! prompt boundary) owns one checkpoint; `/rewind <n>` restores every file to
//! its state before prompt `n` (cascading through all turns >= n).
//!
//! Scope note: mutations made through raw shell commands are untracked (grok
//! solves this with an optional git rewind); this module tracks tool-level
//! `write`/`edit` mutations only.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointFileMeta {
    path: PathBuf,
    snapshot: String,
    existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointMeta {
    turn: u64,
    files: Vec<CheckpointFileMeta>,
}

#[derive(Debug, Default)]
struct CheckpointState {
    turn: u64,
    captured: HashSet<PathBuf>,
}

/// Summary of one checkpoint turn for `/rewind` listings.
#[derive(Debug, Clone)]
pub struct CheckpointSummary {
    pub turn: u64,
    pub files: Vec<PathBuf>,
}

/// Outcome of a rewind operation.
#[derive(Debug, Default)]
pub struct RewindReport {
    pub restored: Vec<PathBuf>,
    pub deleted: Vec<PathBuf>,
    pub failed: Vec<(PathBuf, String)>,
}

#[derive(Debug, Clone)]
pub struct CheckpointManager {
    root: std::sync::Arc<std::sync::RwLock<PathBuf>>,
    state: std::sync::Arc<Mutex<CheckpointState>>,
}

impl CheckpointManager {
    pub fn new(session_dir: impl AsRef<Path>) -> Self {
        Self {
            root: std::sync::Arc::new(std::sync::RwLock::new(
                session_dir.as_ref().join("checkpoints"),
            )),
            state: std::sync::Arc::new(Mutex::new(CheckpointState::default())),
        }
    }

    fn root(&self) -> PathBuf {
        self.root
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Rebind this manager to a replacement session and discard only its
    /// in-memory prompt-boundary cache. Durable checkpoints remain on disk.
    pub fn rebind(&self, session_dir: impl AsRef<Path>) {
        *self
            .root
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            session_dir.as_ref().join("checkpoints");
        *self.lock() = CheckpointState::default();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CheckpointState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn turn_dir(&self, turn: u64) -> PathBuf {
        self.root().join(turn.to_string())
    }

    fn meta_path(&self, turn: u64) -> PathBuf {
        self.turn_dir(turn).join("meta.json")
    }

    fn read_meta(&self, turn: u64) -> Option<CheckpointMeta> {
        let raw = std::fs::read_to_string(self.meta_path(turn)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn write_meta(&self, meta: &CheckpointMeta) -> Result<()> {
        let dir = self.turn_dir(meta.turn);
        std::fs::create_dir_all(&dir)?;
        let raw = serde_json::to_string_pretty(meta)?;
        std::fs::write(dir.join("meta.json"), raw)?;
        Ok(())
    }

    /// Rotate to the checkpoint of `turn` when the prompt boundary moved; must
    /// be called with the current user-request index before each snapshot.
    fn ensure_turn(&self, turn: u64) {
        let mut state = self.lock();
        if state.turn != turn {
            state.turn = turn;
            state.captured.clear();
        }
    }

    /// Snapshot `path` before its first mutation in `turn`. Later calls for
    /// the same file in the same turn are no-ops (the earliest original wins).
    pub fn snapshot_before_write(&self, turn: u64, path: &Path) {
        self.ensure_turn(turn);
        let normalized = path.to_path_buf();
        {
            let state = self.lock();
            if state.captured.contains(&normalized) {
                return;
            }
        }
        let existed = path.exists();
        let snapshot_name = format!("f{}.snap", sanitize_name(&normalized));
        let snapshot_path = self.turn_dir(turn).join(&snapshot_name);
        let snapshot_ok = if existed {
            std::fs::create_dir_all(self.turn_dir(turn)).is_ok()
                && std::fs::copy(path, &snapshot_path).is_ok()
        } else {
            std::fs::create_dir_all(self.turn_dir(turn)).is_ok()
        };
        if !snapshot_ok {
            return;
        }

        let mut meta = self.read_meta(turn).unwrap_or(CheckpointMeta {
            turn,
            files: Vec::new(),
        });
        if meta.files.iter().any(|f| f.path == normalized) {
            return;
        }
        meta.files.push(CheckpointFileMeta {
            path: normalized.clone(),
            snapshot: snapshot_name,
            existed,
        });
        if self.write_meta(&meta).is_ok() {
            self.lock().captured.insert(normalized);
        }
    }

    /// List checkpoint turns in ascending order.
    pub fn list(&self) -> Vec<CheckpointSummary> {
        let mut turns = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.root()) else {
            return turns;
        };
        let mut ids: Vec<u64> = entries
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
            .collect();
        ids.sort_unstable();
        for id in ids {
            if let Some(meta) = self.read_meta(id) {
                turns.push(CheckpointSummary {
                    turn: id,
                    files: meta.files.iter().map(|f| f.path.clone()).collect(),
                });
            }
        }
        turns
    }

    /// Restore every file to its state before prompt `turn`, cascading all
    /// turns >= turn (earliest snapshot per file wins; files first created
    /// after the boundary are deleted).
    pub fn rewind(&self, turn: u64) -> Result<RewindReport> {
        let summaries = self.list();
        let relevant: Vec<&CheckpointSummary> =
            summaries.iter().filter(|s| s.turn >= turn).collect();
        if relevant.is_empty() {
            anyhow::bail!("no checkpoint found for turn {turn}");
        }

        // First-seen (earliest turn) snapshot wins per file; files marked
        // "did not exist" at their earliest sighting are scheduled for
        // deletion regardless of later edits.
        let mut plan: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for summary in &relevant {
            let Some(meta) = self.read_meta(summary.turn) else {
                continue;
            };
            for file in meta.files {
                if seen.contains(&file.path) {
                    continue;
                }
                seen.insert(file.path.clone());
                let restore_from = file
                    .existed
                    .then(|| self.turn_dir(summary.turn).join(&file.snapshot));
                plan.push((file.path, restore_from));
            }
        }

        let mut report = RewindReport::default();
        for (path, restore_from) in plan {
            match restore_from {
                Some(snapshot) => {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match std::fs::copy(&snapshot, &path) {
                        Ok(_) => report.restored.push(path),
                        Err(error) => report
                            .failed
                            .push((path, format!("restore failed: {error}"))),
                    }
                }
                None => match std::fs::remove_file(&path) {
                    Ok(_) => report.deleted.push(path),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        report.deleted.push(path)
                    }
                    Err(error) => report
                        .failed
                        .push((path, format!("delete failed: {error}"))),
                },
            }
        }
        Ok(report)
    }
}

fn sanitize_name(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Extract the target path of a write/edit-style tool input, if any.
pub fn tool_target_path(input: &serde_json::Value) -> Option<PathBuf> {
    for key in ["file_path", "path", "target_file", "target_path"] {
        if let Some(value) = input.get(key).and_then(|value| value.as_str())
            && !value.trim().is_empty()
        {
            return Some(PathBuf::from(value));
        }
    }
    None
}

/// Summary line for transcripts after a rewind.
pub fn rewind_summary(report: &RewindReport) -> String {
    let mut parts = Vec::new();
    if !report.restored.is_empty() {
        parts.push(format!("{} file(s) restored", report.restored.len()));
    }
    if !report.deleted.is_empty() {
        parts.push(format!("{} file(s) deleted", report.deleted.len()));
    }
    if !report.failed.is_empty() {
        parts.push(format!("{} file(s) failed", report.failed.len()));
    }
    if parts.is_empty() {
        "nothing to rewind".to_string()
    } else {
        parts.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_and_rewind_restores_content_and_deletes_new_files() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("session");
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let manager = CheckpointManager::new(&session);

        let existing = work.join("existing.txt");
        std::fs::write(&existing, b"original").unwrap();
        let created = work.join("created.txt");

        // Turn 1: snapshot both files, then mutate.
        manager.snapshot_before_write(1, &existing);
        manager.snapshot_before_write(1, &created);
        std::fs::write(&existing, b"mutated").unwrap();
        std::fs::write(&created, b"brand new").unwrap();

        // Same file again in the same turn: earliest original is kept.
        manager.snapshot_before_write(1, &existing);
        let report = manager.rewind(1).unwrap();
        assert_eq!(report.restored, vec![existing.clone()]);
        assert_eq!(report.deleted, vec![created.clone()]);
        assert_eq!(std::fs::read(&existing).unwrap(), b"original");
        assert!(!created.exists());
    }

    #[test]
    fn rewind_cascades_earliest_snapshot_across_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("session");
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let manager = CheckpointManager::new(&session);

        let file = work.join("f.txt");
        std::fs::write(&file, b"v1").unwrap();
        manager.snapshot_before_write(1, &file);
        std::fs::write(&file, b"v2").unwrap();
        manager.snapshot_before_write(2, &file);
        std::fs::write(&file, b"v3").unwrap();

        // Rewind to turn 2: restores v2 (the state before prompt 2).
        manager.rewind(2).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"v2");

        // Rewind to turn 1: restores v1.
        manager.rewind(1).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"v1");
    }

    #[test]
    fn list_reports_turns_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let manager = CheckpointManager::new(tmp.path());
        let file = tmp.path().join("a.txt");
        manager.snapshot_before_write(2, &file);
        manager.snapshot_before_write(1, &file);
        let turns = manager.list();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn, 1);
        assert_eq!(turns[1].turn, 2);
    }

    #[test]
    fn rewind_unknown_turn_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let manager = CheckpointManager::new(tmp.path());
        assert!(manager.rewind(9).is_err());
    }

    #[test]
    fn rebind_switches_durable_session_without_leaking_cached_turn_state() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        let work = tmp.path().join("work.txt");
        std::fs::write(&work, b"first original").unwrap();
        let manager = CheckpointManager::new(&first);
        manager.snapshot_before_write(1, &work);
        std::fs::write(&work, b"first changed").unwrap();

        manager.rebind(&second);
        assert!(manager.list().is_empty());
        manager.snapshot_before_write(1, &work);
        std::fs::write(&work, b"second changed").unwrap();
        manager.rewind(1).unwrap();
        assert_eq!(std::fs::read(&work).unwrap(), b"first changed");

        manager.rebind(&first);
        manager.rewind(1).unwrap();
        assert_eq!(std::fs::read(&work).unwrap(), b"first original");
    }
}
