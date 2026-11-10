//! Host-resolved identities for target-owned work storage.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::continuous_work::WorkScope;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Holds the original profile and workspace directories while a host reads or
/// writes work. The principal must come from the authenticated host, never an
/// RPC field. These identities do not grant access to a thread or source.
pub struct HostWorkScope {
    profile_path: PathBuf,
    workspace_path: PathBuf,
    profile: PrivateDirectory,
    workspace: PrivateDirectory,
    profile_identity: String,
    workspace_identity: String,
    scope: WorkScope,
}

impl HostWorkScope {
    /// Capture existing directories without initializing work storage.
    pub fn capture(profile: &Path, workspace: &Path, principal: Option<&str>) -> Result<Self> {
        ensure!(
            profile.is_absolute() && workspace.is_absolute(),
            "CONTINUOUS_WORK_SCOPE_INVALID"
        );
        let principal = principal
            .map(|value| uuid::Uuid::parse_str(value).map(|id| id.to_string()))
            .transpose()
            .context("CONTINUOUS_WORK_PRINCIPAL_INVALID")?
            .unwrap_or_else(|| "local".into());
        let profile_path = profile
            .canonicalize()
            .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
        let workspace_path = workspace
            .canonicalize()
            .context("CONTINUOUS_WORK_WORKSPACE_UNAVAILABLE")?;
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        profile.verify_private_directory()?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        let profile_identity = profile.directory_identity()?;
        let workspace_identity = workspace.directory_identity()?;
        let account_id = identity("account", &[&profile_identity, &principal]);
        let target_id = identity("target", &[&profile_identity]);
        let workspace_id = identity("workspace", &[&profile_identity, &workspace_identity]);
        let scope = WorkScope {
            account_id,
            target_id,
            workspace_id,
        };
        let captured = Self {
            profile_path,
            workspace_path,
            profile,
            workspace,
            profile_identity,
            workspace_identity,
            scope,
        };
        captured.verify()?;
        Ok(captured)
    }

    /// Recheck the held objects and their current names after filesystem I/O.
    pub fn verify(&self) -> Result<()> {
        self.profile.verify_private_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                    == self.profile_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace_identity,
            "CONTINUOUS_WORK_SCOPE_CHANGED"
        );
        Ok(())
    }

    pub fn scope(&self) -> &WorkScope {
        &self.scope
    }

    pub fn profile_path(&self) -> &Path {
        &self.profile_path
    }
}

fn identity(domain: &str, values: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kcoder-continuous-work-scope-v1\0");
    digest.update(domain.as_bytes());
    for value in values {
        digest.update([0]);
        digest.update(value.as_bytes());
    }
    format!("native-{:x}", digest.finalize())
}
