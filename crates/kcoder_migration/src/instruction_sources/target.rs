//! Source scope never authorizes a destination; callers explicitly map to an owned trusted target.
use super::{model::*, read};
use anyhow::{Result, ensure};
use kcoder_config::imported_context::{ImportedContext, ImportedContextKind, ImportedContextScope};
use kcoder_config::{FolderTrust, FolderTrustStore, PrivateDirectory};
use kcoder_types::imported_instructions::{
    ImportedInstructionProvenance, ImportedInstructionTrigger,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[path = "target/scoped.rs"]
mod scoped;
pub use scoped::ScopedInstructionDestination;

/// This private Native binding is captured from the actual selected target, never a source path.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionDestination {
    profile: PathBuf,
    profile_identity: String,
    root: PathBuf,
    root_identity: String,
}
impl std::fmt::Debug for InstructionDestination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstructionDestination")
            .finish_non_exhaustive()
    }
}
impl InstructionDestination {
    pub fn capture(profile: &Path, authorized_workspace: &Path) -> Result<Self> {
        ensure!(
            [profile, authorized_workspace]
                .iter()
                .all(|path| path.is_absolute()
                    && !path.components().any(|part| matches!(
                        part,
                        std::path::Component::CurDir | std::path::Component::ParentDir
                    ))),
            "migration_instruction_target_invalid"
        );
        let original_profile = PrivateDirectory::open_existing(profile)?;
        let original_root = PrivateDirectory::open_existing(authorized_workspace)?;
        let profile = profile.canonicalize()?;
        let root = authorized_workspace.canonicalize()?;
        let profile_dir = PrivateDirectory::open_existing(&profile)?;
        profile_dir.verify_trusted_config_directory()?;
        let root_dir = PrivateDirectory::open_existing(&root)?;
        root_dir.verify_trusted_config_directory()?;
        ensure!(
            profile_dir.directory_identity()? == original_profile.directory_identity()?
                && root_dir.directory_identity()? == original_root.directory_identity()?,
            "migration_instruction_target_changed"
        );
        let result = Self {
            profile,
            profile_identity: profile_dir.directory_identity()?,
            root,
            root_identity: root_dir.directory_identity()?,
        };
        result.verify()?;
        Ok(result)
    }
    pub fn verify(&self) -> Result<()> {
        for (path, id) in [
            (&self.profile, &self.profile_identity),
            (&self.root, &self.root_identity),
        ] {
            ensure!(
                path.canonicalize()? == *path,
                "migration_instruction_target_changed"
            );
            let directory = PrivateDirectory::open_existing(path)?;
            directory.verify_trusted_config_directory()?;
            ensure!(
                directory.directory_identity()? == *id,
                "migration_instruction_target_changed"
            );
        }
        ensure!(
            FolderTrustStore::load(&self.profile).check(&self.root) == FolderTrust::Trusted,
            "migration_instruction_target_untrusted"
        );
        Ok(())
    }
    fn scope(&self, relative: &str) -> Result<(PathBuf, String)> {
        self.verify()?;
        let mut path = self.root.clone();
        let mut directory = PrivateDirectory::open_existing(&path)?;
        for part in read::parts(relative)? {
            directory = directory.open_child(OsStr::new(part), false)?;
            directory.verify_trusted_config_directory()?;
            path.push(part);
        }
        ensure!(
            path.canonicalize()? == path
                && FolderTrustStore::load(&self.profile).check(&path) == FolderTrust::Trusted,
            "migration_instruction_target_untrusted"
        );
        self.verify()?;
        Ok((path, directory.directory_identity()?))
    }
}
#[derive(Debug, Clone)]
pub struct InstructionResolution {
    pub id: String,
    pub name: String,
    pub target_relative_scope: String,
    pub enabled: bool,
}
impl InstructionSourceSnapshot {
    /// Compilation is pure after source and destination validation. Ordinary compatible guides
    /// become actual scoped ImportedContext records, while unsupported candidates stay reviewable.
    pub fn prepare_records(
        &self,
        target: &InstructionDestination,
        selected: &[InstructionResolution],
        operation_id: &str,
    ) -> Result<Vec<ImportedContext>> {
        self.verify_consumer(&target.profile)?;
        self.verify_source(|_| true)?;
        target.verify()?;
        ensure!(
            !selected.is_empty()
                && selected.len() <= MAX_FILES
                && !operation_id.is_empty()
                && operation_id.len() <= 80
                && operation_id
                    .bytes()
                    .all(|v| v.is_ascii_alphanumeric() || v == b'-'),
            "migration_instruction_selection_invalid"
        );
        ensure!(
            self.complete_launch_chain,
            "migration_instruction_semantics_require_review"
        );
        let cohort = format!("instruction-{:x}", Sha256::digest(operation_id.as_bytes()));
        let mut seen = std::collections::BTreeSet::new();
        let mut records = Vec::new();
        let mut content_bytes = 0usize;
        for selection in selected {
            ensure!(
                seen.insert(&selection.id),
                "migration_instruction_selection_invalid"
            );
            let source = self
                .candidates
                .iter()
                .find(|row| row.id == selection.id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            ensure!(
                source.disposition == InstructionDisposition::Selected,
                "migration_instruction_semantics_require_review"
            );
            ensure!(
                !selection.name.trim().is_empty()
                    && selection.name.len() <= 256
                    && !selection.name.chars().any(char::is_control),
                "migration_invalid_asset_name"
            );
            let bytes = self.original_bytes(&source.id)?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
            let (content, exact_file_bytes) = if self.version == 1 {
                let (metadata, _) = crate::asset_adapter::frontmatter(text)?;
                ensure!(
                    metadata.is_empty()
                        && !text.lines().any(|line| line.trim_start().starts_with('@')),
                    "migration_instruction_semantics_require_review"
                );
                (text.to_owned(), true)
            } else if self.source() == kcoder_types::migration::MigrationSourceKind::Codex {
                (text.to_owned(), true)
            } else {
                let compiled = super::format::compile(self, &source.relative_path)?;
                (compiled.text, compiled.exact_file_bytes)
            };
            content_bytes = content_bytes.checked_add(content.len()).ok_or_else(|| {
                anyhow::anyhow!("migration_instruction_selection_budget_exceeded")
            })?;
            ensure!(
                content_bytes <= MAX_BYTES,
                "migration_instruction_selection_budget_exceeded"
            );
            let (root, target_identity) = target.scope(&selection.target_relative_scope)?;
            let observation = self
                .observations
                .get(&source.relative_path)
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
            let revision = format!("{:x}", Sha256::digest(&bytes));
            let source_identity = observation
                .identity
                .as_ref()
                .filter(|_| exact_file_bytes && !self.root.is_received())
                .map(|id| {
                    serde_json::to_vec(id).map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                })
                .transpose()?;
            let key = format!(
                "{:x}",
                Sha256::digest(format!("{operation_id}\0{}", source.id).as_bytes())
            );
            records.push(ImportedContext {
                id: format!("ctx-{key}"),
                operation_id: format!("instruction-{key}"),
                name: selection.name.clone(),
                kind: ImportedContextKind::Instructions,
                scope: ImportedContextScope::Project { root },
                content,
                enabled: selection.enabled,
                memory_provenance: None,
                memory_workspace_identity: None,
                instruction_provenance: Some(Box::new(ImportedInstructionProvenance {
                    version: 1,
                    source: self.root.source(),
                    source_relative_path: source.relative_path.clone(),
                    source_sha256: revision,
                    source_file_identity: source_identity,
                    cohort_id: cohort.clone(),
                    rank: source.rank,
                    trigger: match source.trigger {
                        InstructionTrigger::Launch => ImportedInstructionTrigger::Launch,
                        InstructionTrigger::OnRead => ImportedInstructionTrigger::OnRead,
                        InstructionTrigger::OnCwd => ImportedInstructionTrigger::OnCwd,
                    },
                    target_root: target.root.clone(),
                    target_root_identity: target.root_identity.clone(),
                    target_workspace_identity: target_identity,
                })),
            });
        }
        records.sort_by_key(|record| {
            record
                .instruction_provenance
                .as_ref()
                .expect("created provenance")
                .rank
        });
        Ok(records)
    }
}
