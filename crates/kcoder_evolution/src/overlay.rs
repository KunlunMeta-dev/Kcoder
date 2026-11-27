//! Overlay slots (plan section 5.1).
//!
//! ```text
//! overlays/<target-component>/
//!   overlay.json            pointers, base revision, flags (commit point)
//!   revisions/<n>/          immutable slot content
//!     lessons.md  checklist.md  examples/<name>.md
//! ```
//!
//! The `stable` and `candidate` slots of the plan are pointers in
//! `overlay.json` to immutable revision directories. Promotion and rollback
//! therefore replace one file atomically, a crash can never leave a
//! half-copied slot, and rollback keeps the candidate content. Every
//! mutation takes the scope lock and an expected document revision.

use crate::error::{EvolutionError, Result};
use crate::paths::target_storage_component;
use crate::store::{
    EvolutionStore, open_child_if_exists, read_bytes_in, read_versioned_in, write_json_in,
};
use kcoder_config::PrivateDirectory;
use kcoder_types::evolution::{
    Channel, OverlayCandidateState, OverlayContent, ProposalExample, TargetKey,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsStr;

/// Default per-slot character limit. Larger content is rejected; the
/// curator merges entries instead of truncating.
pub const OVERLAY_SLOT_MAX_CHARS: usize = 6000;
/// Superseded revisions kept besides the current stable and candidate.
pub const OVERLAY_RETAINED_REVISIONS: usize = 5;
const OVERLAYS_DIR: &str = "overlays";
const REVISIONS_DIR: &str = "revisions";
const DOCUMENT_FILE: &str = "overlay.json";
const OVERLAY_VERSION: u32 = 1;
const MAX_EXAMPLES: usize = 32;
const SLOT_FILE_MAX_BYTES: u64 = 64 * 1024;

/// Who produced a slot's content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlaySlotSource {
    Proposal,
    User,
    Curator,
}

/// The stable slot pointer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlaySlot {
    pub revision: u64,
    pub chars: u64,
    pub source: OverlaySlotSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    pub updated_at_ms: u64,
}

/// The candidate slot pointer and its rollout state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayCandidate {
    pub revision: u64,
    pub chars: u64,
    pub state: OverlayCandidateState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary_started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traffic: Option<f64>,
    pub updated_at_ms: u64,
}

/// `overlay.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayDocument {
    pub version: u32,
    pub target_key: TargetKey,
    /// Document revision for compare-and-swap; increments on every write.
    pub revision: u64,
    /// Target base revision the slots were written or revalidated against.
    pub base_revision: String,
    /// The target's base revision changed; slots are shown but not served.
    pub needs_revalidation: bool,
    /// The user pinned the stable slot; candidates are not served.
    pub pinned_stable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable: Option<OverlaySlot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<OverlayCandidate>,
    /// Older revisions kept for inspection, newest last.
    #[serde(default)]
    pub retained: Vec<u64>,
    pub next_slot_revision: u64,
    pub updated_at_ms: u64,
}

impl OverlayDocument {
    /// Whether a canary is currently serving the candidate.
    pub fn canary_active(&self) -> bool {
        !self.pinned_stable
            && !self.needs_revalidation
            && self
                .candidate
                .as_ref()
                .is_some_and(|candidate| candidate.state == OverlayCandidateState::Canary)
    }

    /// Overlay revision served on `channel`, or `None` when nothing is
    /// injected (no overlay or revalidation pending).
    pub fn serving_revision(&self, channel: Channel) -> Option<u64> {
        if self.needs_revalidation {
            return None;
        }
        if channel == Channel::Candidate && self.canary_active() {
            return self.candidate.as_ref().map(|candidate| candidate.revision);
        }
        self.stable.as_ref().map(|slot| slot.revision)
    }
}

/// A document plus the content of both slots.
#[derive(Debug, Clone, PartialEq)]
pub struct OverlayView {
    pub document: OverlayDocument,
    pub stable: Option<OverlayContent>,
    pub candidate: Option<OverlayContent>,
}

fn validate_content(content: &OverlayContent) -> Result<u64> {
    if content.lessons.contains('\0') || content.checklist.contains('\0') {
        return Err(EvolutionError::InvalidContent(
            "content must not contain NUL",
        ));
    }
    if content.examples.len() > MAX_EXAMPLES {
        return Err(EvolutionError::InvalidContent(
            "at most 32 examples per slot",
        ));
    }
    let mut names = BTreeSet::new();
    for example in &content.examples {
        let valid_name = !example.name.is_empty()
            && example.name.len() <= 64
            && example
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        if !valid_name {
            return Err(EvolutionError::InvalidContent(
                "example names must be 1..=64 characters from [A-Za-z0-9_-]",
            ));
        }
        if !names.insert(example.name.as_str()) {
            return Err(EvolutionError::InvalidContent(
                "example names must be unique",
            ));
        }
        if example.text.contains('\0') {
            return Err(EvolutionError::InvalidContent(
                "content must not contain NUL",
            ));
        }
    }
    let chars = content.char_count();
    if chars > OVERLAY_SLOT_MAX_CHARS {
        return Err(EvolutionError::ContentTooLarge {
            limit: OVERLAY_SLOT_MAX_CHARS,
            actual: chars,
        });
    }
    Ok(chars as u64)
}

fn check_expected(document: Option<&OverlayDocument>, expected: Option<u64>) -> Result<()> {
    let actual = document.map(|document| document.revision);
    if actual != expected {
        return Err(EvolutionError::RevisionConflict { expected, actual });
    }
    Ok(())
}

fn write_slot_files(directory: &PrivateDirectory, content: &OverlayContent) -> Result<()> {
    directory.atomic_replace(OsStr::new("lessons.md"), content.lessons.as_bytes())?;
    directory.atomic_replace(OsStr::new("checklist.md"), content.checklist.as_bytes())?;
    if !content.examples.is_empty() {
        let examples = directory.create_private_child(OsStr::new("examples"))?;
        for example in &content.examples {
            examples.atomic_replace(
                OsStr::new(&format!("{}.md", example.name)),
                example.text.as_bytes(),
            )?;
        }
    }
    Ok(())
}

fn read_text(directory: &PrivateDirectory, name: &str) -> Result<String> {
    let bytes = read_bytes_in(directory, name, SLOT_FILE_MAX_BYTES)?.unwrap_or_default();
    String::from_utf8(bytes)
        .map_err(|_| EvolutionError::InvalidContent("overlay slot file is not UTF-8"))
}

fn read_slot_files(directory: &PrivateDirectory) -> Result<OverlayContent> {
    let mut content = OverlayContent {
        lessons: read_text(directory, "lessons.md")?,
        checklist: read_text(directory, "checklist.md")?,
        examples: Vec::new(),
    };
    if let Some(examples) = open_child_if_exists(directory, "examples")? {
        let mut names: Vec<String> = examples
            .entry_names_bounded(MAX_EXAMPLES * 2)?
            .into_iter()
            .filter_map(|name| name.into_string().ok())
            .filter(|name| name.ends_with(".md") && !name.starts_with('.'))
            .collect();
        names.sort();
        for name in names {
            let text = read_text(&examples, &name)?;
            content.examples.push(ProposalExample {
                name: name.trim_end_matches(".md").to_string(),
                text,
            });
        }
    }
    Ok(content)
}

struct OverlayDirs {
    target: PrivateDirectory,
}

impl OverlayDirs {
    fn revisions(&self) -> Result<PrivateDirectory> {
        Ok(self.target.open_child(OsStr::new(REVISIONS_DIR), true)?)
    }

    fn document(&self) -> Result<Option<OverlayDocument>> {
        read_versioned_in(&self.target, DOCUMENT_FILE, OVERLAY_VERSION)
    }

    fn write_document(&self, document: &OverlayDocument) -> Result<()> {
        write_json_in(&self.target, DOCUMENT_FILE, document)
    }

    /// Write an immutable revision directory through a temporary name.
    fn write_revision(&self, revision: u64, content: &OverlayContent) -> Result<()> {
        let revisions = self.revisions()?;
        let final_name = revision.to_string();
        let staging = format!(".tmp-{revision}");
        for name in [&final_name, &staging] {
            // Leftovers of an interrupted write that never committed.
            if open_child_if_exists(&revisions, name)?.is_some() {
                revisions.remove_child_tree(OsStr::new(name))?;
            }
        }
        let directory = revisions.create_private_child(OsStr::new(&staging))?;
        write_slot_files(&directory, content)?;
        drop(directory);
        revisions.rename_no_replace(OsStr::new(&staging), OsStr::new(&final_name))?;
        Ok(())
    }

    fn read_revision(&self, revision: u64) -> Result<Option<OverlayContent>> {
        let Some(revisions) = open_child_if_exists(&self.target, REVISIONS_DIR)? else {
            return Ok(None);
        };
        match open_child_if_exists(&revisions, &revision.to_string())? {
            Some(directory) => Ok(Some(read_slot_files(&directory)?)),
            None => Ok(None),
        }
    }

    /// Remove revision directories no longer referenced by the document.
    fn collect_garbage(&self, document: &OverlayDocument) -> Result<()> {
        let mut keep: BTreeSet<String> = document.retained.iter().map(u64::to_string).collect();
        if let Some(stable) = &document.stable {
            keep.insert(stable.revision.to_string());
        }
        if let Some(candidate) = &document.candidate {
            keep.insert(candidate.revision.to_string());
        }
        let revisions = self.revisions()?;
        for name in revisions.entry_names_bounded(1024)? {
            let Some(text) = name.to_str() else { continue };
            if !keep.contains(text) {
                revisions.remove_child_tree(&name)?;
            }
        }
        Ok(())
    }
}

fn retire(document: &mut OverlayDocument, revision: u64) {
    if document.retained.contains(&revision) {
        return;
    }
    document.retained.push(revision);
    let excess = document
        .retained
        .len()
        .saturating_sub(OVERLAY_RETAINED_REVISIONS);
    document.retained.drain(..excess);
}

impl EvolutionStore {
    fn overlay_dirs(&self, key: &TargetKey, create: bool) -> Result<Option<OverlayDirs>> {
        let component = target_storage_component(key);
        let overlays = if create {
            self.directory()
                .open_child(OsStr::new(OVERLAYS_DIR), true)?
        } else {
            match open_child_if_exists(self.directory(), OVERLAYS_DIR)? {
                Some(directory) => directory,
                None => return Ok(None),
            }
        };
        let target = if create {
            overlays.open_child(OsStr::new(&component), true)?
        } else {
            match open_child_if_exists(&overlays, &component)? {
                Some(directory) => directory,
                None => return Ok(None),
            }
        };
        Ok(Some(OverlayDirs { target }))
    }

    /// Current `overlay.json` of a target, if any.
    pub fn overlay_document(&self, key: &TargetKey) -> Result<Option<OverlayDocument>> {
        let Some(dirs) = self.overlay_dirs(key, false)? else {
            return Ok(None);
        };
        let document = dirs.document()?;
        if let Some(document) = &document
            && &document.target_key != key
        {
            return Err(EvolutionError::InvalidOverlayState(
                "overlay directory belongs to another target key",
            ));
        }
        Ok(document)
    }

    /// Document plus slot content.
    pub fn read_overlay(&self, key: &TargetKey) -> Result<Option<OverlayView>> {
        let Some(document) = self.overlay_document(key)? else {
            return Ok(None);
        };
        let dirs = self
            .overlay_dirs(key, false)?
            .ok_or_else(|| EvolutionError::OverlayNotFound(key.to_string()))?;
        let stable = match &document.stable {
            Some(slot) => dirs.read_revision(slot.revision)?,
            None => None,
        };
        let candidate = match &document.candidate {
            Some(slot) => dirs.read_revision(slot.revision)?,
            None => None,
        };
        Ok(Some(OverlayView {
            document,
            stable,
            candidate,
        }))
    }

    /// Content to inject for `channel`: `None` when there is no overlay or
    /// revalidation is pending. Candidate content is served only during an
    /// active, unpinned canary.
    pub fn serving_overlay(
        &self,
        key: &TargetKey,
        channel: Channel,
    ) -> Result<Option<(u64, OverlayContent)>> {
        let Some(document) = self.overlay_document(key)? else {
            return Ok(None);
        };
        let Some(revision) = document.serving_revision(channel) else {
            return Ok(None);
        };
        let dirs = self
            .overlay_dirs(key, false)?
            .ok_or_else(|| EvolutionError::OverlayNotFound(key.to_string()))?;
        Ok(dirs
            .read_revision(revision)?
            .map(|content| (revision, content)))
    }

    /// All overlay documents of this scope (bounded).
    pub fn list_overlay_documents(&self) -> Result<Vec<OverlayDocument>> {
        let Some(overlays) = open_child_if_exists(self.directory(), OVERLAYS_DIR)? else {
            return Ok(Vec::new());
        };
        let mut documents = Vec::new();
        for name in overlays.entry_names_bounded(100_000)? {
            let Some(text) = name.to_str() else { continue };
            let Some(target) = open_child_if_exists(&overlays, text)? else {
                continue;
            };
            if let Some(document) =
                read_versioned_in::<OverlayDocument>(&target, DOCUMENT_FILE, OVERLAY_VERSION)?
                && target_storage_component(&document.target_key) == text
            {
                documents.push(document);
            }
        }
        documents.sort_by(|left, right| left.target_key.cmp(&right.target_key));
        Ok(documents)
    }

    fn mutate_overlay(
        &self,
        key: &TargetKey,
        expected: Option<u64>,
        now_ms: u64,
        content: Option<&OverlayContent>,
        apply: impl FnOnce(&mut OverlayDocument, Option<(u64, u64)>) -> Result<()>,
    ) -> Result<OverlayDocument> {
        let chars = content.map(validate_content).transpose()?;
        let _lock = self.lock()?;
        let dirs = self
            .overlay_dirs(key, true)?
            .ok_or_else(|| EvolutionError::OverlayNotFound(key.to_string()))?;
        let current = dirs.document()?;
        check_expected(current.as_ref(), expected)?;
        let mut document = current.unwrap_or_else(|| OverlayDocument {
            version: OVERLAY_VERSION,
            target_key: key.clone(),
            revision: 0,
            base_revision: String::new(),
            needs_revalidation: false,
            pinned_stable: false,
            stable: None,
            candidate: None,
            retained: Vec::new(),
            next_slot_revision: 1,
            updated_at_ms: now_ms,
        });
        let written = match (content, chars) {
            (Some(content), Some(chars)) => {
                let revision = document.next_slot_revision;
                dirs.write_revision(revision, content)?;
                document.next_slot_revision = revision + 1;
                Some((revision, chars))
            }
            _ => None,
        };
        apply(&mut document, written)?;
        document.revision += 1;
        document.updated_at_ms = now_ms;
        dirs.write_document(&document)?;
        dirs.collect_garbage(&document)?;
        Ok(document)
    }

    /// Replace the stable slot with user (or curator) content. `expected`
    /// is `None` when the overlay must not exist yet. The write also records
    /// `base_revision` as validated and clears `needs_revalidation`.
    pub fn write_stable_overlay(
        &self,
        key: &TargetKey,
        expected: Option<u64>,
        base_revision: &str,
        content: &OverlayContent,
        source: OverlaySlotSource,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        self.mutate_overlay(key, expected, now_ms, Some(content), |document, written| {
            let (revision, chars) = written.expect("content was written");
            if let Some(previous) = document.stable.take() {
                retire(document, previous.revision);
            }
            document.stable = Some(OverlaySlot {
                revision,
                chars,
                source,
                proposal_id: None,
                updated_at_ms: now_ms,
            });
            document.base_revision = base_revision.to_string();
            document.needs_revalidation = false;
            Ok(())
        })
    }

    /// Write a proposal's content into the candidate slot (state `staged`).
    /// Fails while another candidate is in canary.
    pub fn stage_candidate(
        &self,
        key: &TargetKey,
        expected: Option<u64>,
        base_revision: &str,
        content: &OverlayContent,
        proposal_id: &str,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        kcoder_types::evolution::validate_evolution_id("proposalId", proposal_id)?;
        self.mutate_overlay(key, expected, now_ms, Some(content), |document, written| {
            if document
                .candidate
                .as_ref()
                .is_some_and(|candidate| candidate.state == OverlayCandidateState::Canary)
            {
                return Err(EvolutionError::InvalidOverlayState(
                    "a candidate is already in canary",
                ));
            }
            if document.stable.is_some() && document.base_revision != base_revision {
                return Err(EvolutionError::InvalidOverlayState(
                    "candidate base revision differs from the overlay; revalidate first",
                ));
            }
            let (revision, chars) = written.expect("content was written");
            if let Some(previous) = document.candidate.take() {
                retire(document, previous.revision);
            }
            document.candidate = Some(OverlayCandidate {
                revision,
                chars,
                state: OverlayCandidateState::Staged,
                proposal_id: Some(proposal_id.to_string()),
                canary_started_at_ms: None,
                traffic: None,
                updated_at_ms: now_ms,
            });
            document.base_revision = base_revision.to_string();
            Ok(())
        })
    }

    /// Start serving a staged candidate to `traffic` of threads.
    pub fn start_canary(
        &self,
        key: &TargetKey,
        expected: u64,
        traffic: f64,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        if !traffic.is_finite() || !(0.0..=1.0).contains(&traffic) {
            return Err(EvolutionError::InvalidOverlayState(
                "traffic must be within [0, 1]",
            ));
        }
        self.mutate_overlay(key, Some(expected), now_ms, None, |document, _| {
            if document.pinned_stable || document.needs_revalidation {
                return Err(EvolutionError::InvalidOverlayState(
                    "a pinned or unvalidated overlay cannot start a canary",
                ));
            }
            let candidate = document
                .candidate
                .as_mut()
                .filter(|candidate| candidate.state == OverlayCandidateState::Staged)
                .ok_or(EvolutionError::InvalidOverlayState("no staged candidate"))?;
            candidate.state = OverlayCandidateState::Canary;
            candidate.canary_started_at_ms = Some(now_ms);
            candidate.traffic = Some(traffic);
            candidate.updated_at_ms = now_ms;
            Ok(())
        })
    }

    /// Make the candidate the stable slot (pointer switch). The previous
    /// stable revision is retained.
    pub fn promote_candidate(
        &self,
        key: &TargetKey,
        expected: u64,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        self.mutate_overlay(key, Some(expected), now_ms, None, |document, _| {
            let candidate = document
                .candidate
                .as_mut()
                .filter(|candidate| {
                    matches!(
                        candidate.state,
                        OverlayCandidateState::Staged | OverlayCandidateState::Canary
                    )
                })
                .ok_or(EvolutionError::InvalidOverlayState(
                    "no candidate to promote",
                ))?;
            candidate.state = OverlayCandidateState::Promoted;
            candidate.updated_at_ms = now_ms;
            let promoted = OverlaySlot {
                revision: candidate.revision,
                chars: candidate.chars,
                source: OverlaySlotSource::Proposal,
                proposal_id: candidate.proposal_id.clone(),
                updated_at_ms: now_ms,
            };
            if let Some(previous) = document.stable.replace(promoted) {
                retire(document, previous.revision);
            }
            Ok(())
        })
    }

    /// Stop serving the candidate. Only the pointer state changes; the
    /// candidate content stays available for inspection.
    pub fn rollback_candidate(
        &self,
        key: &TargetKey,
        expected: u64,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        self.mutate_overlay(key, Some(expected), now_ms, None, |document, _| {
            let candidate = document
                .candidate
                .as_mut()
                .filter(|candidate| {
                    matches!(
                        candidate.state,
                        OverlayCandidateState::Staged | OverlayCandidateState::Canary
                    )
                })
                .ok_or(EvolutionError::InvalidOverlayState(
                    "no candidate to roll back",
                ))?;
            candidate.state = OverlayCandidateState::RolledBack;
            candidate.updated_at_ms = now_ms;
            Ok(())
        })
    }

    /// Record the target's current base revision. When it differs from the
    /// overlay's, the overlay is marked as needing revalidation (shown but
    /// not served). Returns whether revalidation is needed afterwards.
    pub fn observe_base_revision(
        &self,
        key: &TargetKey,
        current_base_revision: &str,
        now_ms: u64,
    ) -> Result<bool> {
        let Some(document) = self.overlay_document(key)? else {
            return Ok(false);
        };
        if document.base_revision == current_base_revision || document.needs_revalidation {
            return Ok(document.needs_revalidation);
        }
        self.mutate_overlay(key, Some(document.revision), now_ms, None, |document, _| {
            document.needs_revalidation = true;
            Ok(())
        })?;
        Ok(true)
    }

    /// Accept the overlay for a new base revision after revalidation.
    pub fn mark_revalidated(
        &self,
        key: &TargetKey,
        expected: u64,
        base_revision: &str,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        self.mutate_overlay(key, Some(expected), now_ms, None, |document, _| {
            document.base_revision = base_revision.to_string();
            document.needs_revalidation = false;
            Ok(())
        })
    }

    /// Pin (or unpin) the stable slot. Pinning stops any canary from being
    /// served without discarding it.
    pub fn set_overlay_pinned(
        &self,
        key: &TargetKey,
        expected: u64,
        pinned: bool,
        now_ms: u64,
    ) -> Result<OverlayDocument> {
        self.mutate_overlay(key, Some(expected), now_ms, None, |document, _| {
            document.pinned_stable = pinned;
            Ok(())
        })
    }
}
