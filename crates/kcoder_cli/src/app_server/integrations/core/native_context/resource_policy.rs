//! Reuse the live organization policy without requiring an integration identity.
use super::organization::OrganizationAuthority;
use anyhow::Result;
use std::sync::Arc;

pub struct ResourceOrganizationPolicy(Option<Arc<OrganizationAuthority>>);

impl ResourceOrganizationPolicy {
    pub fn capture() -> Result<Self> {
        Ok(Self(OrganizationAuthority::capture()?))
    }

    pub fn organization_id(&self) -> Option<String> {
        self.0.as_ref().map(|policy| policy.organization_id.clone())
    }

    pub fn revision(&self) -> Result<Option<u64>> {
        match &self.0 {
            Some(policy) => policy.verify().map(Some),
            None => {
                OrganizationAuthority::verify_personal_launch()?;
                Ok(None)
            }
        }
    }

    pub fn authorize(&self, action: &str, resource: &str, request: &str) -> Result<()> {
        self.revision()?;
        if let Some(policy) = &self.0 {
            policy.authorize(action, resource, request)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeDomain, NativeDomainGuard, NativeIdentity, NativeIntegrationContext};
    use kcoder_config::PrivateDirectory;
    use kcoder_integration_storage::profile_resources::ProfileResourceContext;
    use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner};
    use std::ffi::OsStr;

    #[test]
    fn expert_resources_keep_original_owner_and_remain_readable_after_native_revocation()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile_path = root.path().join("profile");
        let workspace = root.path().join("workspace");
        let profile = PrivateDirectory::open_or_create(&profile_path)?;
        PrivateDirectory::open_or_create(&workspace)?;
        let native =
            NativeIntegrationContext::capture(&profile_path, &workspace, "original", "config")?;
        let (guard, ()) = NativeDomainGuard::initialize(
            &profile,
            native.scope(),
            NativeDomain::WorkspaceResources,
            "install-expert",
            |directory| {
                directory.append(OsStr::new("expert-resource"), b"original reference")?;
                Ok(())
            },
        )?;
        let resources = ProfileResourceContext::capture(&profile_path, &workspace, None)?;
        assert_eq!(
            IntegrationOwner::from(resources.scope()),
            IntegrationOwner::from(native.scope())
        );
        let mut global = native.scope().clone();
        global.workspace_id = IntegrationNullable::Null;
        let identity = NativeIdentity::observe(&profile, &global)?.unwrap();
        identity.disable(
            &profile,
            "revoke-native",
            identity.snapshot(&profile)?.revision,
            1000,
        )?;
        assert!(native.verify().is_err());
        resources.validate_scope(resources.scope())?;
        assert_eq!(ResourceOrganizationPolicy::capture()?.revision()?, None);
        let reopened = NativeDomainGuard::observe(
            resources.profile(),
            resources.scope(),
            NativeDomain::WorkspaceResources,
        )?
        .unwrap();
        assert_eq!(guard.namespace_id(), reopened.namespace_id());
        assert_eq!(
            reopened
                .directory(resources.profile())?
                .directory_identity()?,
            guard.directory(&profile)?.directory_identity()?,
        );
        let mut foreign = resources.scope().clone();
        foreign.workspace_id = IntegrationNullable::Value("other-workspace".into());
        assert!(resources.validate_scope(&foreign).is_err());
        Ok(())
    }
}
