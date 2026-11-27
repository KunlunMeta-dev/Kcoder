//! Evolution storage maintenance and host inputs:
//!
//! - the conversation classification queue is persisted per scope
//!   (`classify-queue.json`), restored once per runtime and pruned after
//!   classification, so a restart never loses pending signals;
//! - journal compaction and evidence expiry run at most once a day per
//!   scope once the journals exceed 1 MiB, under a job lease ([`kcoder_evolution::EvolutionStore::compact_journals`]);
//! - [`EvolutionTurnFileSink`] uses host captures to supplement tool-input
//!   artifact baselines on turns without delegated work.

use super::{EvolutionRuntime, PendingClassification, ScopeKind, now_ms, short_hash};
use crate::QueryEngine;
use kcoder_evolution::{CompactionPolicy, QueuedClassification, SignalWeights};
use kcoder_state::AppState;
use kcoder_types::evolution::{
    ArtifactRef, EVOLUTION_RECORD_VERSION, ProfileHints, UsageAmendment,
};
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Queued classifications older than this are dropped.
const QUEUE_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Minimum spacing of compaction checks in one process.
const COMPACTION_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Minimum spacing of compactions of one scope (persisted).
const COMPACTION_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const COMPACTION_JOB: &str = "compact";
/// Journals smaller than this together are not worth compacting.
const COMPACTION_MIN_BYTES: u64 = 1024 * 1024;
/// Most captured files attributed to one usage.
const CAPTURED_FILES_MAX: usize = 16;

fn queued(item: &PendingClassification, now: u64) -> QueuedClassification {
    let bound = |text: &str| {
        kcoder_evolution::truncate_snippet(text, kcoder_evolution::CLASSIFY_QUEUE_TEXT_MAX_BYTES)
            .to_string()
    };
    QueuedClassification {
        usage_id: item.usage_id.clone(),
        user_text: bound(&item.user_text),
        previous_answer: bound(&item.previous_answer),
        overlay_text: item.overlay_text.as_deref().map(bound),
        concurrent: u32::try_from(item.concurrent).unwrap_or(u32::MAX),
        queued_at_ms: now,
    }
}

impl EvolutionRuntime {
    /// Persist newly queued classifications in their scopes' stores.
    pub(crate) fn persist_classifications(&self, items: &[PendingClassification], cwd: &Path) {
        let now = now_ms();
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let scoped: Vec<QueuedClassification> = items
                .iter()
                .filter(|item| item.scope == scope)
                .map(|item| queued(item, now))
                .collect();
            if scoped.is_empty() {
                continue;
            }
            if let Some(store) = self.store(scope, cwd)
                && let Err(error) = store.enqueue_classifications(&scoped)
            {
                self.note_diagnostic(format!("classification queue not persisted: {error}"));
            }
        }
    }

    /// Remove classified (or discarded) items from the persisted queues.
    pub(crate) fn forget_classifications(&self, items: &[PendingClassification], cwd: &Path) {
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let ids: Vec<String> = items
                .iter()
                .filter(|item| item.scope == scope)
                .map(|item| item.usage_id.clone())
                .collect();
            if ids.is_empty() {
                continue;
            }
            if let Some(store) = self.store(scope, cwd) {
                let _ = store.remove_classifications(&ids);
            }
        }
    }

    /// Keep only items still in the persisted queue: another engine may
    /// already have classified them. Items of an unreadable store are kept.
    pub(crate) fn still_queued(
        &self,
        batch: Vec<PendingClassification>,
        cwd: &Path,
    ) -> Vec<PendingClassification> {
        let mut persisted: HashMap<ScopeKind, Option<Vec<String>>> = HashMap::new();
        batch
            .into_iter()
            .filter(|item| {
                let ids = persisted.entry(item.scope).or_insert_with(|| {
                    self.store(item.scope, cwd)
                        .and_then(|store| store.read_classification_queue().ok())
                        .map(|queue| queue.into_iter().map(|item| item.usage_id).collect())
                });
                ids.as_ref().is_none_or(|ids| ids.contains(&item.usage_id))
            })
            .collect()
    }

    /// Load persisted classifications once per store into this runtime.
    pub(crate) fn restore_classification_queue(&self, cwd: &Path) {
        let cutoff = now_ms().saturating_sub(QUEUE_MAX_AGE_MS);
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let Some(store) = self.store(scope, cwd) else {
                continue;
            };
            let first = self
                .automation
                .restored_queues
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(store.path().to_path_buf());
            if !first {
                continue;
            }
            let _ = store.expire_classifications(cutoff);
            let Ok(items) = store.read_classification_queue() else {
                continue;
            };
            let mut state = self.lock_state();
            for item in items {
                if state
                    .pending
                    .iter()
                    .any(|pending| pending.usage_id == item.usage_id)
                {
                    continue;
                }
                state.pending.push(PendingClassification {
                    usage_id: item.usage_id,
                    scope,
                    user_text: item.user_text,
                    previous_answer: item.previous_answer,
                    overlay_text: item.overlay_text,
                    concurrent: item.concurrent as usize,
                });
            }
        }
    }
}

impl QueryEngine {
    /// Compact journals and expire evidence, at most once a day per scope.
    pub(crate) fn maybe_compact_evolution(&self, settings: &kcoder_config::Settings, force: bool) {
        if !force
            && !super::canary::due(
                &self.evolution.automation.last_compaction_check,
                COMPACTION_CHECK_INTERVAL,
            )
        {
            return;
        }
        let now = now_ms();
        let weights = SignalWeights::from_settings(&settings.evolution.signals);
        for scope in [ScopeKind::User, ScopeKind::Project] {
            let Some(store) = self.evolution.store(scope, &self.cwd) else {
                continue;
            };
            let recent = store.read_state().ok().and_then(|state| {
                state
                    .jobs
                    .get(COMPACTION_JOB)
                    .and_then(|record| record.last_run_at_ms)
            });
            if !force
                && (recent.is_some_and(|at| now.saturating_sub(at) < COMPACTION_INTERVAL_MS)
                    || journal_bytes(store.path()) < COMPACTION_MIN_BYTES)
            {
                continue;
            }
            let Ok(Some(_lease)) = store.try_job_lease(COMPACTION_JOB, None) else {
                continue;
            };
            let _ = store.purge_expired_evidence(now);
            match store.compact_journals(&weights, CompactionPolicy::new(now)) {
                Ok(_) => {
                    let _ = store.record_job_run(COMPACTION_JOB, None, now);
                }
                Err(error) => self
                    .evolution
                    .note_diagnostic(format!("journal compaction failed: {error}")),
            }
        }
    }

    /// Sink for the files the host's turn file capture saw a settled turn
    /// change. `None` for engines that do not collect (internal forks).
    pub fn evolution_turn_file_sink(&self) -> Option<EvolutionTurnFileSink> {
        (self.request_class == crate::request_admission::RequestClass::Foreground).then(|| {
            EvolutionTurnFileSink {
                runtime: Arc::clone(&self.evolution),
                state: self.state.clone(),
                settings: Arc::clone(&self.settings),
                cwd: self.cwd.clone(),
            }
        })
    }
}

/// Combined size of the journals of an `evolution/` directory.
fn journal_bytes(directory: &Path) -> u64 {
    [
        "usages.jsonl",
        "outcomes.jsonl",
        "usage-amendments.jsonl",
        "usage-tool-calls.jsonl",
    ]
    .iter()
    .filter_map(|name| std::fs::metadata(directory.join(name)).ok())
    .map(|metadata| metadata.len())
    .sum()
}

/// Receives captured file changes of settled turns (see the module docs).
#[derive(Clone)]
pub struct EvolutionTurnFileSink {
    runtime: Arc<EvolutionRuntime>,
    state: AppState,
    settings: Arc<RwLock<kcoder_config::Settings>>,
    cwd: PathBuf,
}

impl std::fmt::Debug for EvolutionTurnFileSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EvolutionTurnFileSink")
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

fn contained_relative(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    (!path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_))))
    .then(|| path.to_path_buf())
}

impl EvolutionTurnFileSink {
    /// Record files (relative to `workspace`; deleted files excluded) that
    /// the most recently settled turn changed. Files already tracked for a
    /// usage keep their baseline.
    pub fn record_turn_files(&self, workspace: &Path, relative_paths: &[String]) {
        let settings = self
            .settings
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let workflow_draft = self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft;
        if !super::collection_allowed(&settings, workflow_draft, true)
            || !settings.evolution.signals.artifact_edits
        {
            return;
        }
        let paths: Vec<PathBuf> = relative_paths
            .iter()
            .filter_map(|path| contained_relative(path))
            .map(|path| workspace.join(path))
            .take(CAPTURED_FILES_MAX)
            .collect();
        if paths.is_empty() {
            return;
        }
        let messages = self.state.messages();
        let Some(start) = messages
            .iter()
            .rposition(kcoder_types::is_real_user_message)
        else {
            return;
        };
        // A shared workspace snapshot identifies paths, while the child
        // records its own direct writes in its own settled turn.
        if messages[start..].iter().any(|message| {
            let kcoder_types::Message::Assistant { content, .. } = message else {
                return false;
            };
            content.iter().any(|block| {
                matches!(block, kcoder_types::ContentBlock::ToolUse { name, .. }
                    if matches!(name.as_str(), "spawn_agent" | "SendMessage" | "Workflow"))
            })
        }) {
            return;
        }
        let turn = super::recording::turn_index(&messages);
        let usages: Vec<_> = self
            .runtime
            .lock_state()
            .open
            .iter()
            .filter(|usage| usage.turn_index == turn && usage.settled)
            .cloned()
            .collect();
        let now = now_ms();
        for usage in usages {
            let Some(store) = self.runtime.store(usage.scope, &self.cwd) else {
                continue;
            };
            let mut artifacts = Vec::new();
            let mut artifact_evidence = BTreeMap::new();
            for path in &paths {
                let tracked = self
                    .runtime
                    .lock_state()
                    .artifacts
                    .entries
                    .iter()
                    .any(|entry| entry.usage_id == usage.usage_id && &entry.path == path);
                if tracked {
                    continue;
                }
                let baseline = self.runtime.lock_state().artifacts.capture(
                    &store,
                    &usage.usage_id,
                    usage.scope,
                    path,
                    now,
                    settings.evolution.evidence_ttl_days,
                );
                if let Some(baseline) = baseline {
                    let display = path.display().to_string();
                    if let Some(evidence) = &baseline.evidence_ref {
                        artifact_evidence.insert(display.clone(), evidence.clone());
                    }
                    artifacts.push(ArtifactRef::File {
                        path: display,
                        content_hash: baseline.hash,
                    });
                }
            }
            if artifacts.is_empty() {
                continue;
            }
            let names: Vec<String> = artifacts
                .iter()
                .map(|artifact| match artifact {
                    ArtifactRef::File { path, .. } => path.clone(),
                    ArtifactRef::Message { message_id } => message_id.clone(),
                })
                .collect();
            let amendment = UsageAmendment {
                version: EVOLUTION_RECORD_VERSION,
                amendment_id: format!(
                    "am-{}",
                    short_hash(&[&usage.usage_id, "capture", &names.join("\n")])
                ),
                usage_id: usage.usage_id.clone(),
                profile_hints: ProfileHints {
                    wrote_files: true,
                    ran_commands: false,
                    text_only: false,
                },
                artifacts,
                artifact_evidence,
                concurrent_targets: Vec::new(),
                recorded_at_ms: now,
            };
            if let Err(error) = store.append_usage_amendment(&amendment) {
                self.runtime
                    .note_diagnostic(format!("captured artifacts not recorded: {error}"));
            }
        }
    }
}
