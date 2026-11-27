//! Pre-promotion snapshot of a self-evolution promotion (plan section 5.2).
//!
//! Promoting a candidate first records the package it replaces:
//!
//! ```text
//! <root>/.evolution-candidates/<name>.promoted.json   previous package + revisions
//! ```
//!
//! A user rollback of that promotion puts the recorded package back through
//! the commit journal with `Exact(promoted revision)`, so an edit made after
//! the promotion is never overwritten: the restore is refused instead. Only
//! the latest promotion of a skill is kept. Like candidates, the document
//! sits in a dot directory outside every package, so discovery, hashing,
//! Doctor and older binaries ignore it.

use super::candidate::{
    CANDIDATES_DIR, CandidateFile, corrupt, decode, encode, validate_proposal_id,
};
use super::hash::canonical_package_revision;
use super::layout::validate_skill_name;
use super::lock::StoreLock;
use super::replace::atomic_write;
use super::{
    ExpectedSkillRevision, SkillCandidate, SkillCommitRequest, SkillMetadataDelta, SkillMutation,
    SkillMutationActor, SkillOperationKind, SkillPackage, SkillRevision, SkillStore,
    SkillStoreError,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const SNAPSHOT_SCHEMA: &str = "kcoder.skill-evolution-pre-promotion/1";
const SNAPSHOT_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotDocument {
    schema: String,
    name: String,
    proposal_id: String,
    /// Live revision before the promotion; the restore target.
    previous_revision: SkillRevision,
    /// Revision the promotion published.
    promoted_revision: SkillRevision,
    files: Vec<CandidateFile>,
}

struct Snapshot {
    proposal_id: String,
    previous_revision: SkillRevision,
    promoted_revision: SkillRevision,
    package: SkillPackage,
}

/// Outcome of [`SkillStore::restore_pre_promotion`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrePromotionRestore {
    /// The package from before the promotion is live (restored now, or by
    /// an earlier attempt whose receipt was lost).
    Restored,
    /// No snapshot of this proposal: it never changed the skill's files, or
    /// a later promotion replaced the record.
    NotRecorded,
    /// The skill changed after the promotion; nothing was written.
    ChangedSincePromotion { actual: Option<SkillRevision> },
}

impl SkillStore {
    fn pre_promotion_path(&self, name: &str) -> PathBuf {
        self.layout
            .root
            .join(CANDIDATES_DIR)
            .join(format!("{name}.promoted.json"))
    }

    /// Record the live package `candidate` replaces. Skipped when the live
    /// skill is not the candidate's base (the promotion then conflicts).
    pub(super) fn record_pre_promotion(
        &self,
        candidate: &SkillCandidate,
    ) -> Result<(), SkillStoreError> {
        let Some(previous) = self.read_package(&candidate.name)? else {
            return Ok(());
        };
        if canonical_package_revision(&previous)? != candidate.base_revision {
            return Ok(());
        }
        let document = SnapshotDocument {
            schema: SNAPSHOT_SCHEMA.to_string(),
            name: candidate.name.clone(),
            proposal_id: candidate.proposal_id.clone(),
            previous_revision: candidate.base_revision.clone(),
            promoted_revision: candidate.candidate_revision.clone(),
            files: previous.files.iter().map(encode).collect(),
        };
        let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
            SkillStoreError::serialization("serializing pre-promotion snapshot", error)
        })?;
        let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        atomic_write(
            &self.pre_promotion_path(&candidate.name),
            &bytes,
            &candidate.proposal_id,
        )
    }

    fn read_pre_promotion(&self, name: &str) -> Result<Option<Snapshot>, SkillStoreError> {
        let path = self.pre_promotion_path(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(SkillStoreError::io("reading pre-promotion snapshot", error));
            }
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SkillStoreError::UnsupportedFileType(path));
        }
        if metadata.len() > SNAPSHOT_MAX_BYTES {
            return Err(corrupt("pre-promotion snapshot too large"));
        }
        let bytes = fs::read(&path)
            .map_err(|error| SkillStoreError::io("reading pre-promotion snapshot", error))?;
        let document: SnapshotDocument = serde_json::from_slice(&bytes).map_err(|error| {
            SkillStoreError::serialization("parsing pre-promotion snapshot", error)
        })?;
        if document.schema != SNAPSHOT_SCHEMA || document.name != name {
            return Err(corrupt("pre-promotion schema or name mismatch"));
        }
        let package = SkillPackage {
            name: document.name,
            files: document
                .files
                .into_iter()
                .map(decode)
                .collect::<Result<_, _>>()?,
        };
        if canonical_package_revision(&package)? != document.previous_revision {
            return Err(corrupt("pre-promotion revision mismatch"));
        }
        Ok(Some(Snapshot {
            proposal_id: document.proposal_id,
            previous_revision: document.previous_revision,
            promoted_revision: document.promoted_revision,
            package,
        }))
    }

    fn remove_pre_promotion(&self, name: &str, proposal_id: &str) -> Result<(), SkillStoreError> {
        let _lock = StoreLock::exclusive(&self.layout, self.lock_timeout)?;
        if self
            .read_pre_promotion(name)?
            .is_some_and(|snapshot| snapshot.proposal_id == proposal_id)
        {
            fs::remove_file(self.pre_promotion_path(name))
                .map_err(|error| SkillStoreError::io("removing pre-promotion snapshot", error))?;
        }
        Ok(())
    }

    /// Roll back the promotion of `proposal_id`: put the recorded previous
    /// package back when the skill is still exactly what the promotion
    /// published. Retrying with the same `operation_id` after a lost
    /// receipt reports [`PrePromotionRestore::Restored`] without writing.
    pub fn restore_pre_promotion(
        &self,
        name: &str,
        proposal_id: &str,
        operation_id: &str,
        actor: SkillMutationActor,
    ) -> Result<PrePromotionRestore, SkillStoreError> {
        validate_skill_name(name)?;
        validate_proposal_id(proposal_id)?;
        if self.receipt(operation_id)?.is_some() {
            self.remove_pre_promotion(name, proposal_id)?;
            return Ok(PrePromotionRestore::Restored);
        }
        let (snapshot, live) = {
            let _snapshot = self.snapshot()?;
            (
                self.read_pre_promotion(name)?,
                self.live_revision_locked(name)?,
            )
        };
        let Some(snapshot) = snapshot.filter(|snapshot| snapshot.proposal_id == proposal_id) else {
            return Ok(PrePromotionRestore::NotRecorded);
        };
        if live.as_ref() == Some(&snapshot.previous_revision) {
            self.remove_pre_promotion(name, proposal_id)?;
            return Ok(PrePromotionRestore::Restored);
        }
        if live.as_ref() != Some(&snapshot.promoted_revision) {
            return Ok(PrePromotionRestore::ChangedSincePromotion { actual: live });
        }
        let committed = self.commit(SkillCommitRequest {
            operation_id: operation_id.to_string(),
            actor,
            operation: SkillOperationKind::Restore,
            preconditions: Vec::new(),
            mutations: vec![SkillMutation::PutPackage {
                package: snapshot.package,
                expected: ExpectedSkillRevision::Exact(snapshot.promoted_revision),
            }],
            metadata: SkillMetadataDelta::default(),
        });
        match committed {
            Ok(_) => {}
            // An edit landed between the check and the commit.
            Err(SkillStoreError::Conflict { .. }) => {
                return Ok(PrePromotionRestore::ChangedSincePromotion {
                    actual: self.current_revision(name)?,
                });
            }
            Err(error) => return Err(error),
        }
        self.remove_pre_promotion(name, proposal_id)?;
        Ok(PrePromotionRestore::Restored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SkillPackageFile, SkillRegistry, skill_revision};

    fn package(body: &str) -> SkillPackage {
        SkillPackage {
            name: "demo".into(),
            files: vec![
                SkillPackageFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    content: format!("---\nname: demo\ndescription: Demo skill\n---\n\n{body}\n")
                        .into_bytes(),
                    executable: false,
                },
                SkillPackageFile {
                    relative_path: PathBuf::from("notes.md"),
                    content: format!("notes for {body}").into_bytes(),
                    executable: false,
                },
            ],
        }
    }

    fn actor() -> SkillMutationActor {
        SkillMutationActor::System {
            component: "self_evolution".into(),
            session_id: None,
        }
    }

    fn promoted(root: &std::path::Path) -> (SkillStore, Vec<u8>, Vec<u8>) {
        let store = SkillStore::open(root).unwrap();
        store
            .commit(SkillCommitRequest {
                operation_id: "create-demo".into(),
                actor: actor(),
                operation: SkillOperationKind::Create,
                preconditions: Vec::new(),
                mutations: vec![SkillMutation::PutPackage {
                    package: package("Stable body."),
                    expected: ExpectedSkillRevision::Absent,
                }],
                metadata: Default::default(),
            })
            .unwrap();
        let skill_md = fs::read(root.join("demo/SKILL.md")).unwrap();
        let notes = fs::read(root.join("demo/notes.md")).unwrap();
        let stable = store.current_revision("demo").unwrap().unwrap();
        store
            .stage_candidate(package("Learned body."), &stable, "prop-1", 1)
            .unwrap();
        store
            .promote_candidate("demo", "prop-1", "evolution-promote-prop-1", actor())
            .unwrap();
        (store, skill_md, notes)
    }

    #[test]
    fn rolling_back_a_promotion_restores_the_previous_bytes_once() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".kcoder/skills");
        let (store, skill_md, notes) = promoted(&root);
        let promoted_revision = store.current_revision("demo").unwrap().unwrap();
        // Older readers see the promoted package; the snapshot is invisible.
        assert_eq!(
            skill_revision(&root.join("demo")).unwrap().unwrap(),
            promoted_revision
        );
        let registry = SkillRegistry::load_project_only(temp.path()).unwrap();
        assert!(
            registry
                .get("demo")
                .unwrap()
                .content
                .contains("Learned body.")
        );
        assert!(store.inspect().unwrap().orphan_paths.is_empty());

        assert_eq!(
            store
                .restore_pre_promotion("demo", "prop-2", "evolution-rollback-prop-2", actor())
                .unwrap(),
            PrePromotionRestore::NotRecorded
        );
        for _ in 0..2 {
            assert_eq!(
                store
                    .restore_pre_promotion("demo", "prop-1", "evolution-rollback-prop-1", actor())
                    .unwrap(),
                PrePromotionRestore::Restored
            );
        }
        assert_eq!(fs::read(root.join("demo/SKILL.md")).unwrap(), skill_md);
        assert_eq!(fs::read(root.join("demo/notes.md")).unwrap(), notes);
        assert!(!store.pre_promotion_path("demo").exists());
    }

    #[test]
    fn a_skill_edited_after_its_promotion_is_not_restored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let (store, _, _) = promoted(&root);
        let edited = "---\nname: demo\ndescription: Demo skill\n---\n\nUser edit.\n";
        fs::write(root.join("demo/SKILL.md"), edited).unwrap();
        let outcome = store
            .restore_pre_promotion("demo", "prop-1", "evolution-rollback-prop-1", actor())
            .unwrap();
        assert!(matches!(
            outcome,
            PrePromotionRestore::ChangedSincePromotion { actual: Some(_) }
        ));
        assert_eq!(
            fs::read_to_string(root.join("demo/SKILL.md")).unwrap(),
            edited,
            "the user's edit is kept"
        );
    }
}
