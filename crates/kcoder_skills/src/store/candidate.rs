//! Self-evolution candidate revision slot (plan section 5.2).
//!
//! A candidate is a complete skill package staged next to the live skill,
//! never in place of it:
//!
//! ```text
//! <root>/.evolution-candidates/<name>.json   candidate package + base revision
//! ```
//!
//! - Staging writes one document by atomic replacement under the store's
//!   exclusive lock, after recovery and only when the live skill still has
//!   the expected stable revision. The live `SKILL.md` and its revision are
//!   untouched, so older binaries (which never read this directory) and
//!   readers of the stable slot keep seeing the stable skill.
//! - Promotion publishes the candidate through the normal commit journal
//!   (`PutPackage` with `Exact(base revision)`), so a concurrent user edit
//!   turns into a conflict instead of being overwritten, then removes the
//!   candidate document. A crash between both steps is reconciled on the
//!   next read: a candidate whose revision is already live is reported as
//!   promoted and removed.
//! - Rollback discards the candidate document; the stable skill was never
//!   changed.
//!
//! The directory starts with a dot, holds no `SKILL.md` and is not part of
//! any package revision, so discovery, hashing and Doctor ignore it.

use super::hash::{canonical_package_revision, load_package, validate_package};
use super::layout::validate_skill_name;
use super::lock::StoreLock;
use super::replace::{atomic_write, create_store_dir};
use super::{
    ExpectedSkillRevision, SkillCommitReceipt, SkillCommitRequest, SkillMetadataDelta,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile,
    SkillRevision, SkillStore, SkillStoreError,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Whether this build's skill store has the candidate revision slot.
pub const SKILL_CANDIDATE_SLOT_SUPPORTED: bool = true;
pub(super) const CANDIDATES_DIR: &str = ".evolution-candidates";
const CANDIDATE_SCHEMA: &str = "kcoder.skill-evolution-candidate/1";
const CANDIDATE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// One staged candidate revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCandidate {
    pub name: String,
    /// Live revision the candidate was derived from.
    pub base_revision: SkillRevision,
    pub candidate_revision: SkillRevision,
    pub proposal_id: String,
    pub staged_at_ms: u64,
    pub package: SkillPackage,
}

/// Read-time state of a candidate relative to the live skill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillCandidateState {
    /// The live skill still has the base revision.
    Staged,
    /// The live skill changed since staging: promotion would conflict.
    Stale,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CandidateFile {
    path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hex: Option<String>,
    #[serde(default)]
    executable: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateDocument {
    schema: String,
    name: String,
    base_revision: SkillRevision,
    candidate_revision: SkillRevision,
    proposal_id: String,
    staged_at_ms: u64,
    files: Vec<CandidateFile>,
}

pub(super) fn encode(file: &SkillPackageFile) -> CandidateFile {
    match std::str::from_utf8(&file.content) {
        Ok(text) => CandidateFile {
            path: file.relative_path.clone(),
            text: Some(text.to_string()),
            hex: None,
            executable: file.executable,
        },
        Err(_) => CandidateFile {
            path: file.relative_path.clone(),
            text: None,
            hex: Some(
                file.content
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            ),
            executable: file.executable,
        },
    }
}

pub(super) fn decode(file: CandidateFile) -> Result<SkillPackageFile, SkillStoreError> {
    let content = match (file.text, file.hex) {
        (Some(text), None) => text.into_bytes(),
        (None, Some(hex)) => {
            if hex.len() % 2 != 0 {
                return Err(corrupt("odd hex length"));
            }
            (0..hex.len())
                .step_by(2)
                .map(|index| {
                    hex.get(index..index + 2)
                        .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                        .ok_or_else(|| corrupt("invalid hex content"))
                })
                .collect::<Result<_, _>>()?
        }
        _ => return Err(corrupt("a file needs exactly one of text or hex")),
    };
    Ok(SkillPackageFile {
        relative_path: file.path,
        content,
        executable: file.executable,
    })
}

pub(super) fn corrupt(reason: &str) -> SkillStoreError {
    SkillStoreError::JournalCorrupt(format!("evolution candidate is corrupt: {reason}"))
}

pub(super) fn validate_proposal_id(id: &str) -> Result<(), SkillStoreError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(SkillStoreError::InvalidOperationId(id.to_string()));
    }
    Ok(())
}

impl SkillStore {
    fn candidate_path(&self, name: &str) -> PathBuf {
        self.layout
            .root
            .join(CANDIDATES_DIR)
            .join(format!("{name}.json"))
    }

    pub(super) fn live_revision_locked(
        &self,
        name: &str,
    ) -> Result<Option<SkillRevision>, SkillStoreError> {
        let path = self.layout.root.join(name);
        if !path.exists() {
            return Ok(None);
        }
        canonical_package_revision(&load_package(&path, name)?).map(Some)
    }

    fn read_candidate_unlocked(
        &self,
        name: &str,
    ) -> Result<Option<SkillCandidate>, SkillStoreError> {
        let path = self.candidate_path(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(SkillStoreError::io("reading evolution candidate", error)),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SkillStoreError::UnsupportedFileType(path));
        }
        if metadata.len() > CANDIDATE_MAX_BYTES {
            return Err(corrupt("document too large"));
        }
        let bytes = fs::read(&path)
            .map_err(|error| SkillStoreError::io("reading evolution candidate", error))?;
        let document: CandidateDocument = serde_json::from_slice(&bytes).map_err(|error| {
            SkillStoreError::serialization("parsing evolution candidate", error)
        })?;
        if document.schema != CANDIDATE_SCHEMA || document.name != name {
            return Err(corrupt("schema or name mismatch"));
        }
        let package = SkillPackage {
            name: document.name.clone(),
            files: document
                .files
                .into_iter()
                .map(decode)
                .collect::<Result<_, _>>()?,
        };
        if canonical_package_revision(&package)? != document.candidate_revision {
            return Err(corrupt("candidate revision mismatch"));
        }
        Ok(Some(SkillCandidate {
            name: document.name,
            base_revision: document.base_revision,
            candidate_revision: document.candidate_revision,
            proposal_id: document.proposal_id,
            staged_at_ms: document.staged_at_ms,
            package,
        }))
    }

    /// Stage `package` as the candidate of its skill. The live skill must
    /// currently have `expected_stable`; an existing candidate is replaced.
    pub fn stage_candidate(
        &self,
        package: SkillPackage,
        expected_stable: &SkillRevision,
        proposal_id: &str,
        now_ms: u64,
    ) -> Result<SkillCandidate, SkillStoreError> {
        validate_skill_name(&package.name)?;
        validate_proposal_id(proposal_id)?;
        let candidate_revision = validate_package(&package)?;
        create_store_dir(&self.layout.root)?;
        let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        super::recovery::recover_locked(self)?;
        let live = self.live_revision_locked(&package.name)?;
        if live.as_ref() != Some(expected_stable) {
            return Err(SkillStoreError::Conflict {
                name: package.name.clone(),
                expected: expected_stable.0.clone(),
                actual: live
                    .map(|revision| revision.0)
                    .unwrap_or_else(|| "absent".into()),
            });
        }
        if candidate_revision == *expected_stable {
            return Err(SkillStoreError::InvalidPackage(
                "the candidate does not change the skill".into(),
            ));
        }
        let document = CandidateDocument {
            schema: CANDIDATE_SCHEMA.to_string(),
            name: package.name.clone(),
            base_revision: expected_stable.clone(),
            candidate_revision: candidate_revision.clone(),
            proposal_id: proposal_id.to_string(),
            staged_at_ms: now_ms,
            files: package.files.iter().map(encode).collect(),
        };
        let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
            SkillStoreError::serialization("serializing evolution candidate", error)
        })?;
        atomic_write(&self.candidate_path(&package.name), &bytes, proposal_id)?;
        Ok(SkillCandidate {
            name: package.name.clone(),
            base_revision: expected_stable.clone(),
            candidate_revision,
            proposal_id: proposal_id.to_string(),
            staged_at_ms: now_ms,
            package,
        })
    }

    /// The staged candidate of `name` and whether it is still based on the
    /// live revision. A candidate that is already live (a promotion whose
    /// cleanup was interrupted) is removed and reported as absent.
    pub fn read_candidate(
        &self,
        name: &str,
    ) -> Result<Option<(SkillCandidate, SkillCandidateState)>, SkillStoreError> {
        validate_skill_name(name)?;
        let _snapshot = self.snapshot()?;
        let Some(candidate) = self.read_candidate_unlocked(name)? else {
            return Ok(None);
        };
        let live = self.live_revision_locked(name)?;
        if live.as_ref() == Some(&candidate.candidate_revision) {
            drop(_snapshot);
            self.discard_candidate(name, Some(&candidate.proposal_id))?;
            return Ok(None);
        }
        let state = if live.as_ref() == Some(&candidate.base_revision) {
            SkillCandidateState::Staged
        } else {
            SkillCandidateState::Stale
        };
        Ok(Some((candidate, state)))
    }

    /// Publish the candidate of `name` (staged for `proposal_id`) through
    /// the commit journal and remove it. Retrying with the same
    /// `operation_id` returns the original receipt.
    pub fn promote_candidate(
        &self,
        name: &str,
        proposal_id: &str,
        operation_id: &str,
        actor: SkillMutationActor,
    ) -> Result<SkillCommitReceipt, SkillStoreError> {
        validate_skill_name(name)?;
        if let Some(receipt) = self.receipt(operation_id)? {
            self.discard_candidate(name, Some(proposal_id))?;
            return Ok(receipt);
        }
        let candidate = {
            let _snapshot = self.snapshot()?;
            self.read_candidate_unlocked(name)?
        }
        .filter(|candidate| candidate.proposal_id == proposal_id)
        .ok_or_else(|| {
            SkillStoreError::InvalidPackage(format!(
                "no evolution candidate of '{name}' for proposal {proposal_id}"
            ))
        })?;
        // Keep the package being replaced so a user rollback can restore
        // it exactly; written first so a lost receipt never loses it.
        self.record_pre_promotion(&candidate)?;
        let receipt = self.commit(SkillCommitRequest {
            operation_id: operation_id.to_string(),
            actor,
            operation: SkillOperationKind::LessonsLearned,
            preconditions: Vec::new(),
            mutations: vec![SkillMutation::PutPackage {
                package: candidate.package,
                expected: ExpectedSkillRevision::Exact(candidate.base_revision),
            }],
            metadata: SkillMetadataDelta::default(),
        })?;
        self.discard_candidate(name, Some(proposal_id))?;
        Ok(receipt)
    }

    /// Discard the candidate of `name` (only the one staged for
    /// `proposal_id` when given). Returns whether a candidate was removed.
    pub fn discard_candidate(
        &self,
        name: &str,
        proposal_id: Option<&str>,
    ) -> Result<bool, SkillStoreError> {
        validate_skill_name(name)?;
        let path = self.candidate_path(name);
        if !path.exists() {
            return Ok(false);
        }
        let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        let Some(candidate) = self.read_candidate_unlocked(name)? else {
            return Ok(false);
        };
        if proposal_id.is_some_and(|id| id != candidate.proposal_id) {
            return Ok(false);
        }
        fs::remove_file(&path)
            .map_err(|error| SkillStoreError::io("removing evolution candidate", error))?;
        if let Some(parent) = path.parent() {
            sync_dir(parent);
        }
        Ok(true)
    }
}

fn sync_dir(path: &Path) {
    if let Ok(directory) = fs::File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SkillRegistry, skill_revision};

    fn package(name: &str, body: &str) -> SkillPackage {
        SkillPackage {
            name: name.to_string(),
            files: vec![SkillPackageFile {
                relative_path: PathBuf::from("SKILL.md"),
                content: format!("---\nname: {name}\ndescription: Demo skill\n---\n\n{body}\n")
                    .into_bytes(),
                executable: false,
            }],
        }
    }

    fn actor() -> SkillMutationActor {
        SkillMutationActor::System {
            component: "self_evolution".into(),
            session_id: None,
        }
    }

    fn create(store: &SkillStore, body: &str) -> SkillRevision {
        store
            .commit(SkillCommitRequest {
                operation_id: "create-demo".into(),
                actor: actor(),
                operation: SkillOperationKind::Create,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    package: package("demo", body),
                    expected: ExpectedSkillRevision::Absent,
                }],
                metadata: Default::default(),
            })
            .unwrap();
        store.current_revision("demo").unwrap().unwrap()
    }

    #[test]
    fn candidates_never_touch_the_stable_skill_until_promotion() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let root = project.join(".kcoder/skills");
        let store = SkillStore::open(&root).unwrap();
        let stable = create(&store, "Stable body.");
        let candidate = store
            .stage_candidate(package("demo", "Candidate body."), &stable, "prop-1", 7)
            .unwrap();
        assert_ne!(candidate.candidate_revision, stable);

        // Older readers: the live file, its revision and discovery are unchanged.
        let live = std::fs::read_to_string(root.join("demo/SKILL.md")).unwrap();
        assert!(live.contains("Stable body."));
        assert_eq!(skill_revision(&root.join("demo")).unwrap().unwrap(), stable);
        let registry = SkillRegistry::load_project_only(project).unwrap();
        assert!(
            registry
                .get("demo")
                .unwrap()
                .content
                .contains("Stable body.")
        );
        assert_eq!(
            registry
                .names()
                .iter()
                .filter(|name| *name == "demo")
                .count(),
            1
        );
        assert!(store.inspect().unwrap().orphan_paths.is_empty());

        let (read, state) = store.read_candidate("demo").unwrap().unwrap();
        assert_eq!(state, SkillCandidateState::Staged);
        assert_eq!(read.proposal_id, "prop-1");

        // Promotion goes through the commit journal and is idempotent.
        let receipt = store
            .promote_candidate("demo", "prop-1", "evolution-promote-prop-1", actor())
            .unwrap();
        let retry = store
            .promote_candidate("demo", "prop-1", "evolution-promote-prop-1", actor())
            .unwrap();
        assert_eq!(receipt, retry);
        assert!(
            std::fs::read_to_string(root.join("demo/SKILL.md"))
                .unwrap()
                .contains("Candidate body.")
        );
        assert!(store.read_candidate("demo").unwrap().is_none());
    }

    #[test]
    fn rollback_discards_and_a_user_edit_makes_the_candidate_stale() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let store = SkillStore::open(&root).unwrap();
        let stable = create(&store, "Stable body.");
        store
            .stage_candidate(package("demo", "Candidate body."), &stable, "prop-1", 7)
            .unwrap();
        assert!(!store.discard_candidate("demo", Some("prop-other")).unwrap());
        assert!(store.discard_candidate("demo", Some("prop-1")).unwrap());
        assert!(store.read_candidate("demo").unwrap().is_none());
        assert_eq!(store.current_revision("demo").unwrap().unwrap(), stable);

        // A stale expected revision is refused at staging.
        let error = store
            .stage_candidate(
                package("demo", "Other."),
                &SkillRevision("sha256:0".into()),
                "prop-2",
                8,
            )
            .unwrap_err();
        assert!(matches!(error, SkillStoreError::Conflict { .. }));

        // A user edit after staging turns promotion into a conflict.
        store
            .stage_candidate(package("demo", "Candidate body."), &stable, "prop-3", 9)
            .unwrap();
        store
            .commit(SkillCommitRequest {
                operation_id: "user-edit".into(),
                actor: actor(),
                operation: SkillOperationKind::Edit,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    package: package("demo", "User edit."),
                    expected: ExpectedSkillRevision::Exact(stable),
                }],
                metadata: Default::default(),
            })
            .unwrap();
        let (_, state) = store.read_candidate("demo").unwrap().unwrap();
        assert_eq!(state, SkillCandidateState::Stale);
        let error = store
            .promote_candidate("demo", "prop-3", "evolution-promote-prop-3", actor())
            .unwrap_err();
        assert!(matches!(error, SkillStoreError::Conflict { .. }));
        assert!(
            std::fs::read_to_string(root.join("demo/SKILL.md"))
                .unwrap()
                .contains("User edit.")
        );
    }
}
