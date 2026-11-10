//! Session state owns the snapshot; profile edits cannot refresh a restored conversation.
use super::*;
use anyhow::{Result, ensure};
use kcoder_types::imported_context_snapshot::{
    ImportedContextSnapshot, ImportedContextSnapshotSource,
};
use sha2::{Digest, Sha256};

impl QueryEngine {
    /// A fork freezes its parent's current boundary without starting a model turn.
    pub fn capture_imported_context_snapshot(&self) -> Result<()> {
        self.frozen_imported_context().map(|_| ())
    }

    pub(super) fn frozen_imported_context(&self) -> Result<Option<ImportedContextSnapshot>> {
        let Some(path) = self.settings_persistence_path() else {
            return Ok(None);
        };
        let profile = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("imported_context_profile_unavailable"))?;
        let identity = profile_identity(profile)?;
        let snapshot = match self.state.reconcile_imported_context_snapshot(&identity)? {
            Some(snapshot) => snapshot,
            None => {
                let legacy = self.state.imported_context_is_legacy_unobserved();
                let content = if legacy {
                    None
                } else {
                    kcoder_config::imported_context::imported_context_prompt(
                        profile,
                        &self.cwd,
                        self.folder_trusted,
                    )?
                };
                let instructions = if legacy {
                    None
                } else {
                    let native =
                        self.project_user_context.as_ref().as_ref().and_then(
                            |message| match message {
                                Message::User { content, .. } => {
                                    content.iter().find_map(|block| match block {
                                        ContentBlock::Text { text } => Some(text.clone()),
                                        _ => None,
                                    })
                                }
                                _ => None,
                            },
                        );
                    kcoder_config::imported_context::ImportedContextStore::open(profile)?
                        .instruction_session(
                            profile_cwd(self),
                            self.folder_trusted,
                            native,
                            &self.project_instruction_facts,
                        )?
                };
                self.state
                    .freeze_imported_context_snapshot(ImportedContextSnapshot {
                        version: if instructions.is_some() { 2 } else { 1 },
                        profile_identity: identity.clone(),
                        source: if legacy {
                            ImportedContextSnapshotSource::LegacyUnobserved
                        } else {
                            ImportedContextSnapshotSource::Captured
                        },
                        content,
                        instructions: instructions.map(Box::new),
                    })?
            }
        };
        ensure!(
            snapshot.profile_identity == identity,
            "imported_context_snapshot_wrong_profile"
        );
        Ok(Some(snapshot))
    }
    pub(super) fn take_legacy_imported_context_notice(&self) -> bool {
        self.state.imported_context_is_legacy_unobserved()
            && !self
                .imported_context_notice
                .swap(true, std::sync::atomic::Ordering::AcqRel)
    }
}

fn profile_cwd(engine: &QueryEngine) -> &std::path::Path {
    &engine.cwd
}

pub(super) fn profile_identity(profile: &std::path::Path) -> Result<String> {
    let directory = kcoder_config::PrivateDirectory::open_existing(profile)?;
    directory.verify_trusted_config_directory()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!(
                "kcoder.imported-context-profile.v1\0{}",
                directory.directory_identity()?
            )
            .as_bytes()
        )
    ))
}
