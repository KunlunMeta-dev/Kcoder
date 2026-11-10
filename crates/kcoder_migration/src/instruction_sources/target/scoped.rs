//! Mapping retains the original existing child identity, not merely a relative path.
use super::InstructionDestination;
use anyhow::{Result, ensure};
use kcoder_config::{
    PrivateDirectory,
    imported_context::{ImportedContext, ImportedContextScope},
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Private Native target proof. Source paths and RPC payloads cannot construct authority.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopedInstructionDestination {
    target: InstructionDestination,
    relative: String,
    scope_root: PathBuf,
    scope_identity: String,
}
impl std::fmt::Debug for ScopedInstructionDestination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopedInstructionDestination")
            .finish_non_exhaustive()
    }
}
impl PartialEq for ScopedInstructionDestination {
    fn eq(&self, other: &Self) -> bool {
        self.target.profile == other.target.profile
            && self.target.profile_identity == other.target.profile_identity
            && self.target.root == other.target.root
            && self.target.root_identity == other.target.root_identity
            && self.relative == other.relative
            && self.scope_root == other.scope_root
            && self.scope_identity == other.scope_identity
    }
}
impl Eq for ScopedInstructionDestination {}
impl ScopedInstructionDestination {
    pub fn capture(target: &InstructionDestination, relative: &str) -> Result<Self> {
        let (scope_root, scope_identity) = target.scope(relative)?;
        let result = Self {
            target: target.clone(),
            relative: relative.into(),
            scope_root,
            scope_identity,
        };
        result.verify(&target.profile)?;
        Ok(result)
    }
    pub fn verify(&self, profile: &Path) -> Result<()> {
        self.target.verify()?;
        let actual = PrivateDirectory::open_existing(profile)?;
        actual.verify_trusted_config_directory()?;
        ensure!(
            profile.canonicalize()? == self.target.profile
                && actual.directory_identity()? == self.target.profile_identity,
            "migration_wrong_target"
        );
        let (root, identity) = self.target.scope(&self.relative)?;
        ensure!(
            root == self.scope_root && identity == self.scope_identity,
            "migration_instruction_target_changed"
        );
        Ok(())
    }
    pub fn relative_scope(&self) -> &str {
        &self.relative
    }
    pub fn scope(&self) -> ImportedContextScope {
        ImportedContextScope::Project {
            root: self.scope_root.clone(),
        }
    }
    pub fn destination(&self) -> &InstructionDestination {
        &self.target
    }
    /// Compare the compiler's actual result with the original mapped child;
    /// repeating capture of a now-replaced child is not a valid rebind.
    pub fn verify_record(&self, profile: &Path, record: &ImportedContext) -> Result<()> {
        self.verify(profile)?;
        let provenance = record
            .instruction_provenance
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_target_changed"))?;
        ensure!(
            record.kind == kcoder_config::imported_context::ImportedContextKind::Instructions
                && record.memory_provenance.is_none()
                && record.memory_workspace_identity.is_none()
                && provenance.version == 1
                && record.scope == self.scope()
                && provenance.target_root == self.target.root
                && provenance.target_root_identity == self.target.root_identity
                && provenance.target_workspace_identity == self.scope_identity,
            "migration_instruction_target_changed"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture {
        _root: tempfile::TempDir,
        profile: PathBuf,
        workspace: PathBuf,
        target: InstructionDestination,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(
            profile.join("trusted-folders.json"),
            serde_json::to_vec(&serde_json::json!({"trusted":[workspace],"never":[]})).unwrap(),
        )
        .unwrap();
        let target = InstructionDestination::capture(&profile, &workspace).unwrap();
        Fixture {
            _root: root,
            profile,
            workspace,
            target,
        }
    }
    #[test]
    fn mapped_child_is_not_silently_recaptured_after_replacement() {
        let f = fixture();
        let mapped = ScopedInstructionDestination::capture(&f.target, "src").unwrap();
        let restored: ScopedInstructionDestination =
            serde_json::from_slice(&serde_json::to_vec(&mapped).unwrap()).unwrap();
        restored.verify(&f.profile).unwrap();
        fs::rename(f.workspace.join("src"), f.workspace.join("retained")).unwrap();
        fs::create_dir(f.workspace.join("src")).unwrap();
        f.target.scope("src").unwrap();
        assert!(mapped.verify(&f.profile).is_err());
        assert!(restored.verify(&f.profile).is_err());
    }
    #[test]
    fn original_account_and_current_trust_are_required_without_new_path_authority() {
        let f = fixture();
        let mapped = ScopedInstructionDestination::capture(&f.target, "src").unwrap();
        assert_eq!(mapped.relative_scope(), "src");
        assert_eq!(
            mapped.scope(),
            ImportedContextScope::Project {
                root: f.workspace.join("src")
            }
        );
        let foreign = tempfile::tempdir().unwrap();
        assert!(mapped.verify(foreign.path()).is_err());
        for path in ["../outside", "/outside", "src/../outside", "missing"] {
            assert!(ScopedInstructionDestination::capture(&f.target, path).is_err());
        }
        fs::write(f.profile.join("trusted-folders.json"), "{}").unwrap();
        assert!(mapped.verify(&f.profile).is_err());
        assert!(ScopedInstructionDestination::capture(&f.target, "src").is_err());
    }
    #[test]
    fn actual_compiler_record_must_keep_the_selected_physical_scope() {
        use crate::instruction_sources::{
            InstructionResolution, InstructionSourceGrant, InstructionSourcePolicy,
        };
        use kcoder_types::migration::MigrationSourceKind;
        let f = fixture();
        fs::create_dir(f.workspace.join(".git")).unwrap();
        fs::write(
            f.workspace.join("AGENTS.md"),
            "Keep the ordinary project contract.",
        )
        .unwrap();
        let snapshot = InstructionSourceGrant::capture(
            &f.profile,
            &f.workspace,
            &f.workspace,
            MigrationSourceKind::Codex,
        )
        .unwrap()
        .capture_sources(&InstructionSourcePolicy::default(), |_| true)
        .unwrap();
        let mapped = ScopedInstructionDestination::capture(&f.target, "src").unwrap();
        let choices = [InstructionResolution {
            id: snapshot.summaries()[0].id.clone(),
            name: "Mapped instructions".into(),
            target_relative_scope: "src".into(),
            enabled: false,
        }];
        let record = snapshot
            .prepare_records(mapped.destination(), &choices, "mapped-source-operation")
            .unwrap()
            .remove(0);
        mapped.verify_record(&f.profile, &record).unwrap();
        let mut changed = record.clone();
        changed.scope = ImportedContextScope::Project {
            root: f.workspace.clone(),
        };
        assert!(mapped.verify_record(&f.profile, &changed).is_err());
        fs::rename(f.workspace.join("src"), f.workspace.join("original-src")).unwrap();
        fs::create_dir(f.workspace.join("src")).unwrap();
        let rebound = snapshot
            .prepare_records(&f.target, &choices, "mapped-source-operation")
            .unwrap()
            .remove(0);
        assert!(mapped.verify_record(&f.profile, &rebound).is_err());
    }
}
