//! Artifact signal adapter (plan section 7.1).
//!
//! When a usage's turn settles, every file it wrote through the direct
//! file-mutation tools gets a baseline: a content hash plus a bounded,
//! redacted snapshot stored as evidence. Edits made outside the agent are
//! detected at the next turn start in the same workspace and at idle polls,
//! for at most seven days; Office documents are compared on extracted text,
//! other binaries (including PDF) on their hash only. A later agent write to
//! the same path moves the baseline, so the agent's own changes never count
//! as user edits.

use super::turns::observation;
use super::{ARTIFACT_OBSERVATION_MS, EvolutionRuntime, ScopeKind, redacted_snippet};
use kcoder_evolution::EvolutionStore;
use kcoder_tools::artifact_text::{
    ARTIFACT_SOURCE_MAX_BYTES, ArtifactText, artifact_text, edit_ratio,
};
use kcoder_types::evolution::{
    ArtifactRef, Attribution, CategoryAssessment, OutcomeCategory, OutcomeObservation, SignalKind,
};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

/// In-memory baseline text kept per artifact (bytes).
const BASELINE_TEXT_MAX_BYTES: usize = 256 * 1024;
/// Most artifacts tracked per engine.
const TRACKED_MAX: usize = 128;

#[derive(Debug, Clone)]
pub(crate) struct TrackedArtifact {
    pub(crate) usage_id: String,
    pub(crate) scope: ScopeKind,
    pub(crate) path: PathBuf,
    pub(crate) baseline_text: Option<String>,
    pub(crate) last_hash: String,
    pub(crate) started_ms: u64,
    pub(crate) edited: bool,
    pub(crate) finished: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct Baseline {
    pub(crate) hash: String,
    pub(crate) evidence_ref: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct ArtifactTracker {
    pub(crate) entries: Vec<TrackedArtifact>,
    pub(crate) restored: HashSet<ScopeKind>,
}

fn content_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256-{hex}")
}

/// Hash and comparable text of a file; `None` when it no longer exists or
/// cannot be read within bounds.
pub(crate) fn read_artifact(path: &Path) -> Option<(String, ArtifactText)> {
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(ARTIFACT_SOURCE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > ARTIFACT_SOURCE_MAX_BYTES {
        return None;
    }
    Some((content_hash(&bytes), artifact_text(path, &bytes)))
}

fn bounded(text: String) -> String {
    kcoder_evolution::truncate_snippet(&text, BASELINE_TEXT_MAX_BYTES).to_string()
}

fn headings(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('#'))
        .collect()
}

/// Rule-based categories of an edit: length and heading structure.
fn edit_categories(before: &str, after: &str) -> Vec<CategoryAssessment> {
    let mut categories = Vec::new();
    let (left, right) = (before.chars().count() as f64, after.chars().count() as f64);
    if left > 0.0 && ((right - left).abs() / left) > 0.2 {
        categories.push(CategoryAssessment {
            category: OutcomeCategory::Length,
            domain: None,
            confidence: 0.9,
        });
    }
    if headings(before) != headings(after) {
        categories.push(CategoryAssessment {
            category: OutcomeCategory::Structure,
            domain: None,
            confidence: 0.8,
        });
    }
    categories
}

impl ArtifactTracker {
    /// Record the baseline of a file written by `usage_id`'s turn.
    pub(crate) fn capture(
        &mut self,
        store: &EvolutionStore,
        usage_id: &str,
        scope: ScopeKind,
        path: &Path,
        now_ms: u64,
        ttl_days: u32,
    ) -> Option<Baseline> {
        let (hash, text) = read_artifact(path)?;
        let text = match text {
            ArtifactText::Text(text) => Some(bounded(text)),
            ArtifactText::Binary => None,
        };
        // The agent wrote this path again: earlier usages compare against
        // the new agent version from now on.
        for entry in self.entries.iter_mut().filter(|entry| entry.path == path) {
            entry.last_hash = hash.clone();
            entry.baseline_text = text.clone();
        }
        let evidence_ref = text.as_deref().and_then(|text| {
            store
                .put_evidence(
                    &format!("artifact baseline\n{}", redacted_snippet(text, 3800)),
                    now_ms,
                    ttl_days,
                )
                .ok()
        });
        if !self
            .entries
            .iter()
            .any(|entry| entry.usage_id == usage_id && entry.path == path)
        {
            if self.entries.len() >= TRACKED_MAX {
                self.entries.remove(0);
            }
            self.entries.push(TrackedArtifact {
                usage_id: usage_id.to_string(),
                scope,
                path: path.to_path_buf(),
                baseline_text: text,
                last_hash: hash.clone(),
                started_ms: now_ms,
                edited: false,
                finished: false,
            });
        }
        Some(Baseline { hash, evidence_ref })
    }

    /// Compare tracked artifacts with the files on disk.
    pub(crate) fn check(&mut self, now_ms: u64) -> Vec<(ScopeKind, OutcomeObservation)> {
        let mut observations = Vec::new();
        let shared: Vec<usize> = self
            .entries
            .iter()
            .map(|entry| {
                self.entries
                    .iter()
                    .filter(|other| !other.finished && other.path == entry.path)
                    .count()
            })
            .collect();
        for (entry, sharing) in self.entries.iter_mut().zip(shared) {
            if entry.finished {
                continue;
            }
            let attribution = if sharing > 1 {
                Attribution::Ambiguous
            } else {
                Attribution::Direct
            };
            if now_ms.saturating_sub(entry.started_ms) >= ARTIFACT_OBSERVATION_MS {
                entry.finished = true;
                if !entry.edited {
                    let mut item = observation(
                        &entry.usage_id,
                        SignalKind::ArtifactKept,
                        "artifact",
                        &[&entry.path.display().to_string(), "kept"],
                    );
                    item.attribution = attribution;
                    observations.push((entry.scope, item));
                }
                continue;
            }
            let path = entry.path.display().to_string();
            match read_artifact(&entry.path) {
                None if !entry.path.exists() => {
                    entry.finished = true;
                    let mut item = observation(
                        &entry.usage_id,
                        SignalKind::ArtifactDiscarded,
                        "artifact",
                        &[&path, "discarded"],
                    );
                    item.attribution = attribution;
                    observations.push((entry.scope, item));
                }
                None => {}
                Some((hash, current)) if hash != entry.last_hash => {
                    let mut item = observation(
                        &entry.usage_id,
                        SignalKind::ArtifactEdit,
                        "artifact",
                        &[&path, &hash],
                    );
                    item.attribution = attribution;
                    match (&entry.baseline_text, &current) {
                        (Some(before), ArtifactText::Text(after)) => {
                            item.metrics.edit_ratio = Some(edit_ratio(before, after));
                            item.categories = edit_categories(before, after);
                        }
                        _ => {
                            // Hash-only comparison: the artifact changed but
                            // there is no comparable text to size the edit.
                            item.metrics.extra.insert("binaryChanged".into(), 1.0);
                        }
                    }
                    if let ArtifactText::Text(after) = current {
                        entry.baseline_text = Some(bounded(after));
                    }
                    entry.last_hash = hash;
                    entry.edited = true;
                    observations.push((entry.scope, item));
                }
                Some(_) => {}
            }
        }
        self.entries.retain(|entry| !entry.finished);
        observations
    }
}

impl EvolutionRuntime {
    /// After a restart, re-track artifacts of this workspace's usages from
    /// the last seven days (once per scope and engine).
    pub(crate) fn restore_artifacts(
        &self,
        store: &EvolutionStore,
        scope: ScopeKind,
        cwd: &Path,
        now_ms: u64,
    ) {
        if !self.lock_state().artifacts.restored.insert(scope) {
            return;
        }
        let Ok(usages) = store.read_amended_usages() else {
            return;
        };
        let finished: HashSet<String> = store
            .read_outcomes()
            .map(|outcomes| {
                outcomes
                    .records
                    .into_iter()
                    .filter(|item| {
                        matches!(
                            item.signal,
                            SignalKind::ArtifactDiscarded | SignalKind::ArtifactKept
                        )
                    })
                    .map(|item| item.usage_id)
                    .collect()
            })
            .unwrap_or_default();
        let amendments = store
            .read_usage_amendments()
            .map(|read| read.records)
            .unwrap_or_default();
        let mut state = self.lock_state();
        for usage in usages.records {
            if now_ms.saturating_sub(usage.started_at_ms) >= ARTIFACT_OBSERVATION_MS
                || finished.contains(&usage.usage_id)
            {
                continue;
            }
            for artifact in &usage.artifacts {
                let ArtifactRef::File { path, content_hash } = artifact else {
                    continue;
                };
                let path = PathBuf::from(path);
                if !path.starts_with(cwd)
                    || state
                        .artifacts
                        .entries
                        .iter()
                        .any(|entry| entry.usage_id == usage.usage_id && entry.path == path)
                {
                    continue;
                }
                let baseline_text = amendments
                    .iter()
                    .filter(|amendment| amendment.usage_id == usage.usage_id)
                    .find_map(|amendment| {
                        amendment.artifact_evidence.get(&path.display().to_string())
                    })
                    .and_then(|id| store.read_evidence(id, now_ms).ok().flatten())
                    .map(|snippet| {
                        snippet
                            .text
                            .strip_prefix("artifact baseline\n")
                            .unwrap_or(&snippet.text)
                            .to_string()
                    });
                state.artifacts.entries.push(TrackedArtifact {
                    usage_id: usage.usage_id.clone(),
                    scope,
                    path,
                    baseline_text,
                    last_hash: content_hash.clone(),
                    started_ms: usage.started_at_ms,
                    edited: false,
                    finished: false,
                });
            }
        }
    }

    /// Check tracked artifacts and append the resulting observations,
    /// skipping ids that are already journaled.
    pub(crate) fn check_artifacts(&self, cwd: &Path, now_ms: u64) {
        let observations = self.lock_state().artifacts.check(now_ms);
        if observations.is_empty() {
            return;
        }
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let items: Vec<&OutcomeObservation> = observations
                .iter()
                .filter(|(item_scope, _)| *item_scope == scope)
                .map(|(_, item)| item)
                .collect();
            if items.is_empty() {
                continue;
            }
            let Some(store) = self.store(scope, cwd) else {
                continue;
            };
            let known: HashSet<String> = store
                .read_outcomes()
                .map(|read| {
                    read.records
                        .into_iter()
                        .map(|item| item.observation_id)
                        .collect()
                })
                .unwrap_or_default();
            for item in items {
                if known.contains(&item.observation_id) {
                    continue;
                }
                if let Err(error) = store.append_outcome(item) {
                    self.note_diagnostic(format!("artifact observation not written: {error}"));
                }
            }
        }
    }
}
