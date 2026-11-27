//! Frozen session context uses the verified logical profile seed after relocation.
use anyhow::Result;
use kcoder_config::{PrivateDirectory, profile_identity::ProfileIdentity};
use sha2::{Digest, Sha256};
use std::path::Path;

/// This is a context namespace identity, not an authorization or revocation verdict.
/// Unrecorded profiles retain the exact legacy hash of their physical identity.
pub fn imported_context_profile_identity(profile: &Path) -> Result<String> {
    let directory = PrivateDirectory::open_existing(profile)?;
    directory.verify_trusted_config_directory()?;
    let logical = ProfileIdentity::observe(&directory)?;
    let identity = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "kcoder.imported-context-profile.v1\0{}",
                logical.logical_seed()
            )
            .as_bytes()
        )
    );
    logical.verify(&directory)?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use kcoder_types::{
        Message,
        imported_context_snapshot::{ImportedContextSnapshot, ImportedContextSnapshotSource},
    };
    use std::{ffi::OsStr, path::PathBuf};

    fn copy_directory(source: &Path, target: &PrivateDirectory) -> Result<()> {
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                let child = target.create_private_child(&entry.file_name())?;
                copy_directory(&entry.path(), &child)?;
            } else {
                anyhow::ensure!(kind.is_file(), "unexpected_synthetic_fixture_entry");
                target.atomic_replace(&entry.file_name(), &std::fs::read(entry.path())?)?;
            }
        }
        Ok(())
    }

    #[test]
    fn unrecorded_profile_keeps_the_exact_legacy_hash_and_observation_creates_nothing() -> Result<()>
    {
        let root = tempfile::tempdir()?;
        let profile = PrivateDirectory::open_or_create(&root.path().join("profile"))?;
        let profile_path = root.path().join("profile");
        let expected = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "kcoder.imported-context-profile.v1\0{}",
                    profile.directory_identity()?
                )
                .as_bytes()
            )
        );
        assert_eq!(imported_context_profile_identity(&profile_path)?, expected);
        assert_eq!(std::fs::read_dir(&profile_path)?.count(), 0);
        Ok(())
    }

    #[test]
    fn moved_session_reopens_original_frozen_context_and_fork_retains_its_profile_identity()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let source_path = root.path().join("source-profile");
        let target_path = root.path().join("target-profile");
        let workspace = root.path().join("external-project");
        let source = PrivateDirectory::open_or_create(&source_path)?;
        let target = PrivateDirectory::open_or_create(&target_path)?;
        PrivateDirectory::open_or_create(&workspace)?;
        let history_root = source_path.join("sessions");
        PrivateDirectory::open_or_create(&history_root)?;
        let state = AppState::new(&workspace);
        let session_id = state.session_id();
        let history = history_root.join(format!("{session_id}.jsonl"));
        state.with_history_path(&history);
        state.add_message(Message::user_text("Original persisted session"));
        state.save_history()?;
        let original = ImportedContextSnapshot {
            version: 1,
            profile_identity: imported_context_profile_identity(&source_path)?,
            source: ImportedContextSnapshotSource::Captured,
            content: Some("ORIGINAL_FROZEN_CONTEXT".into()),
            instructions: None,
        };
        state.freeze_imported_context_snapshot(original.clone())?;
        let relative = history.strip_prefix(&source_path)?.to_path_buf();
        drop(state);
        copy_directory(&source_path, &target)?;
        let relocated_history = target_path.join(relative);
        let copied = AppState::new(&workspace);
        copied.resume_from_history(&relocated_history)?;
        assert!(
            copied
                .reconcile_imported_context_snapshot(&imported_context_profile_identity(
                    &target_path
                )?)
                .is_err()
        );
        drop(copied);
        ProfileIdentity::observe(&source)?.relocate(&source, &target, "move-session-profile")?;
        let identity = imported_context_profile_identity(&target_path)?;
        assert_eq!(identity, original.profile_identity);
        let restored = AppState::new(&workspace);
        restored.resume_from_history(&relocated_history)?;
        assert_eq!(restored.session_id(), session_id);
        assert_eq!(restored.cwd(), workspace);
        assert_eq!(
            restored.reconcile_imported_context_snapshot(&identity)?,
            Some(original.clone())
        );
        let fork_root = target_path.join("forks");
        PrivateDirectory::open_or_create(&fork_root)?;
        let fork = AppState::new(&workspace);
        fork.inherit_imported_context_snapshot(&restored)?;
        let fork_history = fork_root.join(format!("{}.jsonl", fork.session_id()));
        fork.with_history_path(&fork_history);
        fork.add_message(Message::user_text("New fork input"));
        fork.save_history()?;
        let reopened_fork = AppState::new(&workspace);
        reopened_fork.resume_from_history(&fork_history)?;
        assert_eq!(
            reopened_fork.reconcile_imported_context_snapshot(&identity)?,
            Some(original)
        );
        assert_eq!(restored.history_path(), Some(relocated_history));
        Ok(())
    }

    #[test]
    fn replaced_mapping_with_identical_json_cannot_rebind_frozen_session_identity() -> Result<()> {
        let root = tempfile::tempdir()?;
        let source_path: PathBuf = root.path().join("source");
        let target_path = root.path().join("target");
        let source = PrivateDirectory::open_or_create(&source_path)?;
        let target = PrivateDirectory::open_or_create(&target_path)?;
        let identity = imported_context_profile_identity(&source_path)?;
        ProfileIdentity::observe(&source)?.relocate(&source, &target, "original-operation")?;
        assert_eq!(imported_context_profile_identity(&target_path)?, identity);
        let record = std::fs::read(target_path.join(".profile-identity.json"))?;
        target.atomic_replace(OsStr::new(".profile-identity.json"), &record)?;
        assert!(imported_context_profile_identity(&target_path).is_err());
        assert_eq!(imported_context_profile_identity(&source_path)?, identity);
        assert_eq!(
            std::fs::read(target_path.join(".profile-identity.json"))?,
            record
        );
        Ok(())
    }
}
