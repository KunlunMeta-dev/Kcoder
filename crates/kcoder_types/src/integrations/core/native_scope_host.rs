//! Private application/Office host locators. Stored metadata grants no execution authority.
use super::{IntegrationScope, IntegrationValidationError, invalid};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeScopeHostResources {
    pub component_root: std::path::PathBuf,
    pub component_manifest_sha256: String,
    pub node_program: std::path::PathBuf,
    pub node_image_sha256: String,
    pub runtime_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub electron_version: Option<String>,
}

/// Immutable infrastructure locators. A stored launch never grants a UI source
/// or a background lifetime; the original live peer/signed lease still does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeScopeHostLaunchSpec {
    pub schema_version: u32,
    pub scope: IntegrationScope,
    pub profile_path: std::path::PathBuf,
    pub workspace_path: std::path::PathBuf,
    pub settings_file: std::path::PathBuf,
    pub configuration_sha256: String,
    pub native_image_sha256: String,
    pub resources: NativeScopeHostResources,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub office: Option<super::NativeOfficeScopeLaunch>,
}
impl NativeScopeHostLaunchSpec {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.scope.validate()?;
        if let Some(office) = &self.office {
            office.validate()?;
        }
        if self.schema_version != 1
            || !self.profile_path.is_absolute()
            || !self.workspace_path.is_absolute()
            || self.settings_file.parent() != Some(self.profile_path.as_path())
            || !self.resources.component_root.is_absolute()
            || !self.resources.node_program.is_absolute()
        {
            return Err(invalid(
                "hostLaunch",
                "fixed absolute native infrastructure locators are required",
            ));
        }
        for value in [
            &self.configuration_sha256,
            &self.native_image_sha256,
            &self.resources.component_manifest_sha256,
            &self.resources.node_image_sha256,
        ] {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(invalid(
                    "hostImage",
                    "complete original native image/configuration observations are required",
                ));
            }
        }
        self.resources.validate_runtime()
    }
}

impl NativeScopeHostResources {
    pub fn validate_runtime(&self) -> Result<(), IntegrationValidationError> {
        let version = |value: &Option<String>| {
            value.as_ref().is_none_or(|value| {
                !value.is_empty()
                    && value.len() <= 80
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+')
                    })
            })
        };
        if !matches!(
            self.runtime_mode.as_str(),
            "standalone_node" | "electron_as_node"
        ) || !version(&self.node_version)
            || !version(&self.electron_version)
            || (self.runtime_mode == "standalone_node" && self.electron_version.is_some())
            || (self.runtime_mode == "electron_as_node"
                && (self.node_version.is_none() || self.electron_version.is_none()))
        {
            return Err(invalid(
                "runtimeMode",
                "the original fixed Node mode and packaged runtime versions are required",
            ));
        }
        Ok(())
    }
}
#[cfg(test)]
mod host_office_compatibility_tests {
    use super::*;

    #[test]
    fn legacy_host_launch_round_trips_without_enabling_or_serializing_office() {
        let legacy = serde_json::json!({
            "schemaVersion":1,
            "scope":{"accountId":"owner","targetId":"target","workspaceId":"workspace",
                "identityGeneration":"1","targetRevision":"1"},
            "profilePath":"/owned/profile","workspacePath":"/owned/workspace",
            "settingsFile":"/owned/profile/settings.json",
            "configurationSha256":"a".repeat(64),"nativeImageSha256":"b".repeat(64),
            "resources":{"componentRoot":"/owned/resources","componentManifestSha256":"c".repeat(64),
                "nodeProgram":"/owned/node","nodeImageSha256":"d".repeat(64),"runtimeMode":"standalone_node"}
        });
        let decoded: NativeScopeHostLaunchSpec = serde_json::from_value(legacy.clone()).unwrap();
        assert!(decoded.office.is_none());
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    }
}
