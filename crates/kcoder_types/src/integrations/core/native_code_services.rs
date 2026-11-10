//! Fixed saved-code service descriptors. JSON is data, never execution authority.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum NativeCodeServiceState {
    Approved,
    Running,
    Stopped,
    Revoked,
    OutcomeUnknown,
}

pub const NATIVE_CODE_SERVICE_TEMPLATE_V1: &str = "native-saved-code-service-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceIntent {
    pub template: String,
    pub lease_id: String,
    pub operation_id: String,
    pub scope: IntegrationScope,
    pub definition_id: String,
    pub definition_version: u64,
    pub definition_sha256: String,
    pub task_sha256: String,
    pub configuration_sha256: String,
    pub native_image_sha256: String,
    pub expires_at_ms: u64,
}
impl NativeCodeServiceIntent {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.scope.validate()?;
        for (field, value) in [
            ("leaseId", &self.lease_id),
            ("operationId", &self.operation_id),
            ("definitionId", &self.definition_id),
        ] {
            id(value, field)?;
        }
        for (field, value) in [
            ("definitionSha256", &self.definition_sha256),
            ("taskSha256", &self.task_sha256),
            ("configurationSha256", &self.configuration_sha256),
            ("nativeImageSha256", &self.native_image_sha256),
        ] {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(invalid(field, "a complete native SHA256 is required"));
            }
        }
        if self.template != NATIVE_CODE_SERVICE_TEMPLATE_V1
            || self.definition_version == 0
            || self.definition_version > 9_007_199_254_740_991
            || self.expires_at_ms == 0
            || self.expires_at_ms > 9_007_199_254_740_991
        {
            return Err(invalid(
                "serviceIntent",
                "a fixed bounded native code service is required",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceGrantView {
    pub reference: IntegrationRevisionRef,
    pub status: IntegrationDelegationStatus,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceRecord {
    pub schema_version: u32,
    pub revision: u64,
    pub intent: NativeCodeServiceIntent,
    pub grant_ref: IntegrationRevisionRef,
    pub state: NativeCodeServiceState,
    #[serde(default)]
    pub enabled: bool,
    pub observed_at_ms: u64,
}
impl NativeCodeServiceRecord {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.intent.validate()?;
        self.grant_ref.validate()?;
        if self.schema_version != 1
            || self.revision == 0
            || self.revision > 9_007_199_254_740_991
            || self.observed_at_ms == 0
            || self.observed_at_ms > 9_007_199_254_740_991
        {
            return Err(invalid(
                "serviceRecord",
                "safe native revision and observation time are required",
            ));
        }
        Ok(())
    }
}

/// Private target locators and approved input. They are bound by the signed task
/// and configuration digests, and never become a public control token.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceLaunchSpec {
    pub schema_version: u32,
    pub lease_id: String,
    pub profile_path: std::path::PathBuf,
    pub workspace_path: std::path::PathBuf,
    pub settings_file: std::path::PathBuf,
    pub task: NativeCodeServiceTask,
}
impl NativeCodeServiceLaunchSpec {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.lease_id, "leaseId")?;
        self.task.validate()?;
        if self.schema_version != 1
            || [
                &self.profile_path,
                &self.workspace_path,
                &self.settings_file,
            ]
            .iter()
            .any(|path| !path.is_absolute())
            || self.settings_file.parent() != Some(self.profile_path.as_path())
        {
            return Err(invalid(
                "launchSpec",
                "fixed absolute target locators are required",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceTask {
    pub definition_id: String,
    pub version: u64,
    pub definition_sha256: String,
    pub args: serde_json::Value,
    pub runtime_operation_id: String,
}
impl NativeCodeServiceTask {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.definition_id, "definitionId")?;
        id(&self.runtime_operation_id, "runtimeOperationId")?;
        if self.version == 0
            || self.version > 9_007_199_254_740_991
            || self.definition_sha256.len() != 64
            || !self
                .definition_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || serde_json::to_vec(&self.args).map_or(true, |bytes| bytes.len() > 32768)
        {
            return Err(invalid(
                "codeTask",
                "a fixed bounded saved code task is required",
            ));
        }
        Ok(())
    }
}
