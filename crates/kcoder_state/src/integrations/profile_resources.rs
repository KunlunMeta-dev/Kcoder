//! Resource ownership follows the app-server's held profile and workspace.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_config::profile_identity::ProfileIdentity;
use kcoder_config::workspace_identity::WorkspaceIdentity;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner, IntegrationScope};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct ProfileResourceContext {
    profile: PrivateDirectory,
    profile_path: PathBuf,
    logical_profile: ProfileIdentity,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    logical_workspace: WorkspaceIdentity,
    scope: IntegrationScope,
}

/// Preserve existing owner IDs so installed resources and task bindings stay valid.
pub fn profile_resource_owner(
    logical_profile_seed: &str,
    workspace_identity: &str,
    organization_id: Option<String>,
) -> IntegrationOwner {
    use profile_resource_identity as identity;
    IntegrationOwner {
        account_id: identity("account-profile", logical_profile_seed),
        target_id: identity("native-target", logical_profile_seed),
        workspace_id: IntegrationNullable::Value(identity(
            "native-workspace",
            &format!("{logical_profile_seed}\0{workspace_identity}"),
        )),
        organization_id: organization_id.map(IntegrationNullable::Value),
    }
}

pub fn profile_resource_identity(domain: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kcoder-native-integrations-v1\0");
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update(value.as_bytes());
    format!("native-{:x}", hash.finalize())
}

impl ProfileResourceContext {
    pub fn capture(
        profile_path: &Path,
        workspace_path: &Path,
        organization_id: Option<String>,
    ) -> Result<Self> {
        ensure!(
            profile_path.is_absolute() && workspace_path.is_absolute(),
            "RESOURCE_PROFILE_UNAVAILABLE"
        );
        let profile = PrivateDirectory::open_existing(profile_path)?;
        profile.verify_config_root_directory()?;
        let workspace = PrivateDirectory::open_existing(workspace_path)?;
        if organization_id.is_some() {
            workspace.verify_private_directory()?;
        }
        let logical_profile = ProfileIdentity::observe(&profile)?;
        let logical_workspace = WorkspaceIdentity::observe(&profile, &workspace)?;
        let owner = profile_resource_owner(
            logical_profile.logical_seed(),
            logical_workspace.logical_seed(),
            organization_id,
        );
        let scope = IntegrationScope {
            account_id: owner.account_id,
            target_id: owner.target_id,
            workspace_id: owner.workspace_id,
            organization_id: owner.organization_id,
            identity_generation: "profile-resources-v1".into(),
            target_revision: "profile-resources-v1".into(),
        };
        scope.validate()?;
        Ok(Self {
            profile,
            profile_path: profile_path.to_path_buf(),
            logical_profile,
            workspace,
            workspace_path: workspace_path.to_path_buf(),
            logical_workspace,
            scope,
        })
    }

    pub fn scope(&self) -> &IntegrationScope {
        &self.scope
    }

    pub fn profile(&self) -> &PrivateDirectory {
        &self.profile
    }

    pub fn profile_path(&self) -> &Path {
        &self.profile_path
    }

    pub fn verify(&self) -> Result<()> {
        self.profile.verify_config_root_directory()?;
        self.logical_profile.verify(&self.profile)?;
        self.logical_workspace
            .verify(&self.profile, &self.workspace)?;
        if self.scope.organization_id.is_some() {
            self.workspace.verify_private_directory()?;
        }
        ensure!(
            PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                == self.profile.directory_identity()?
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace.directory_identity()?,
            "RESOURCE_OWNER_CHANGED"
        );
        Ok(())
    }

    /// Scope values are locators. The held directories establish the actual owner.
    pub fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        scope.validate()?;
        self.verify()?;
        ensure!(
            IntegrationOwner::from(scope) == IntegrationOwner::from(&self.scope),
            "RESOURCE_OWNER_CHANGED"
        );
        Ok(())
    }
}
