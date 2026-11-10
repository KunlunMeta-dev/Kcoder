//! Private source observations for an original Office scope transfer, never authority.
use super::{IntegrationValidationError, invalid};
use serde::{Deserialize, Serialize};

/// Only the original verified producer may place this data in its protected scope
/// launch. Deserializing it cannot construct the native receiver capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeOfficeScopeLaunch {
    pub schema_version: u32,
    pub original_launch: String,
    pub profile_identity: String,
    pub workspace_identity: String,
    pub workspace_digest: String,
    /// Full manifest/runtime/source identity; retained copy paths are excluded.
    pub configuration_sha256: String,
}
impl NativeOfficeScopeLaunch {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        let sha = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let identity = |value: &str| {
            !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
        };
        if self.schema_version != 1
            || self.original_launch.is_empty()
            || self.original_launch.len() > 65536
            || !self
                .original_launch
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !identity(&self.profile_identity)
            || !identity(&self.workspace_identity)
            || !sha(&self.workspace_digest)
            || !sha(&self.configuration_sha256)
        {
            return Err(invalid(
                "officeScopeLaunch",
                "bounded original native source observations are required",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn office_scope_data_is_bounded_and_rejects_authority_labels() {
        let value = serde_json::json!({
            "schemaVersion":1,"originalLaunch":"e30","profileIdentity":"original-profile-handle",
            "workspaceIdentity":"original-workspace-handle","workspaceDigest":"a".repeat(64),
            "configurationSha256":"b".repeat(64)
        });
        let data: NativeOfficeScopeLaunch = serde_json::from_value(value.clone()).unwrap();
        data.validate().unwrap();
        // This is shape-only data. The actual startup parser still rejects {};
        // the native receiver additionally requires its original kernel owner.
        let mut injected = value.clone();
        injected["trusted"] = serde_json::json!(true);
        assert!(serde_json::from_value::<NativeOfficeScopeLaunch>(injected).is_err());
        for field in ["workspaceDigest", "configurationSha256", "originalLaunch"] {
            let mut changed = value.clone();
            changed[field] = serde_json::json!("unprotected/path");
            assert!(
                serde_json::from_value::<NativeOfficeScopeLaunch>(changed)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}
