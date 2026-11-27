//! Task-host infrastructure is independent of platform and execution grants.
use super::{
    IntegrationOwner, IntegrationScope, IntegrationValidationError, NativeOfficeScopeLaunch,
    invalid,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppServerHostIdentity {
    pub owner: IntegrationOwner,
    pub identity_generation: String,
}

impl From<&IntegrationScope> for AppServerHostIdentity {
    fn from(scope: &IntegrationScope) -> Self {
        Self {
            owner: IntegrationOwner::from(scope),
            identity_generation: scope.identity_generation.clone(),
        }
    }
}

/// Immutable launch metadata, never a task, source or background execution permit.
/// Model, knowledge, SDK resources and transient settings revisions are absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppServerHostLaunchSpec {
    pub schema_version: u32,
    pub identity: AppServerHostIdentity,
    pub profile_path: PathBuf,
    pub workspace_path: PathBuf,
    pub settings_file: PathBuf,
    pub native_image_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub office: Option<AppServerHostOfficeLaunch>,
}

/// Original retained component data only; it grants no Office action or material access.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppServerHostOfficeLaunch {
    pub resource_copy_ref: String,
    pub launch: NativeOfficeScopeLaunch,
}
impl AppServerHostOfficeLaunch {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.launch.validate()?;
        let digest = self
            .resource_copy_ref
            .strip_prefix("scope-host-")
            .ok_or_else(|| {
                invalid(
                    "appServerHostOffice",
                    "original retained resource reference is required",
                )
            })?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(invalid(
                "appServerHostOffice",
                "original retained resource reference is required",
            ));
        }
        Ok(())
    }
}

impl AppServerHostLaunchSpec {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        if let Some(office) = &self.office {
            office.validate()?;
        }
        let owner = &self.identity.owner;
        IntegrationScope {
            account_id: owner.account_id.clone(),
            target_id: owner.target_id.clone(),
            workspace_id: owner.workspace_id.clone(),
            organization_id: owner.organization_id.clone(),
            identity_generation: self.identity.identity_generation.clone(),
            target_revision: "app-server-host-v1".into(),
        }
        .validate()?;
        if owner.workspace_id.as_ref().is_none()
            || self.schema_version != 1
            || !self.profile_path.is_absolute()
            || !self.workspace_path.is_absolute()
            || self.settings_file.parent() != Some(self.profile_path.as_path())
            || self.settings_file.file_name().is_none()
            || self.native_image_sha256.len() != 64
            || !self
                .native_image_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(invalid(
                "appServerHost",
                "an isolated workspace, fixed absolute locators and original image are required",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppServerHostSelection {
    pub revision: u64,
    pub launch_ref: String,
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_identity_ignores_settings_revision_but_keeps_every_isolation_boundary() {
        let scope: IntegrationScope = serde_json::from_value(serde_json::json!({
            "accountId":"account", "targetId":"target", "workspaceId":"workspace",
            "identityGeneration":"generation", "targetRevision":"settings-one"
        }))
        .unwrap();
        let mut updated = scope.clone();
        updated.target_revision = "settings-two".into();
        assert_eq!(
            AppServerHostIdentity::from(&scope),
            AppServerHostIdentity::from(&updated)
        );
        updated.workspace_id = super::super::IntegrationNullable::Value("other-project".into());
        assert_ne!(
            AppServerHostIdentity::from(&scope),
            AppServerHostIdentity::from(&updated)
        );
        updated = scope.clone();
        updated.identity_generation = "revoked-identity".into();
        assert_ne!(
            AppServerHostIdentity::from(&scope),
            AppServerHostIdentity::from(&updated)
        );
        let mut serialized = serde_json::to_value(AppServerHostIdentity::from(&scope)).unwrap();
        serialized["backgroundAuthorized"] = true.into();
        assert!(serde_json::from_value::<AppServerHostIdentity>(serialized).is_err());
    }
}
