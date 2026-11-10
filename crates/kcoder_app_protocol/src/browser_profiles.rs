//! Host-bound browser account catalog. Metadata never grants a website login.
use kcoder_types::browser_profiles::BrowserAccountProfileDraft;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_BROWSER_PROFILES_V1: &str = "browserProfilesV1";
pub const CAPABILITY_BROWSER_PROFILE_SESSIONS_V1: &str = "browserProfileSessionsV1";
pub const BROWSER_PROFILE_HANDOFF: &str = "browser/profile/handoff";
pub const BROWSER_PROFILE_CONTROL_READ: &str = "browser/profile/controlRead";
pub const BROWSER_PROFILE_HUMAN_ACTION: &str = "browser/profile/humanAction";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct BrowserControlReadParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum BrowserControlMode {
    Automation,
    Human,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserHandoffParams {
    pub session_id: String,
    pub expected_revision: u64,
    pub mode: BrowserControlMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserHandoffState {
    pub session_id: String,
    pub revision: u64,
    pub mode: BrowserControlMode,
    pub observed_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserHumanActionParams {
    pub expected_revision: u64,
    pub action: crate::BrowserActionParams,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProfileSelection {
    pub scope: kcoder_types::integrations::core::IntegrationScope,
    pub profile_id: String,
    pub expected_revision: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum BrowserProfilesMethod {
    #[serde(rename = "integrations/browserProfiles/list")]
    List,
    #[serde(rename = "integrations/browserProfiles/save")]
    Save,
    #[serde(rename = "integrations/browserProfiles/setArchived")]
    SetArchived,
}
impl BrowserProfilesMethod {
    pub fn parse(method: &str) -> Option<Self> {
        Some(match method {
            "integrations/browserProfiles/list" => Self::List,
            "integrations/browserProfiles/save" => Self::Save,
            "integrations/browserProfiles/setArchived" => Self::SetArchived,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProfilesListParams {
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProfilesSaveParams {
    pub draft: BrowserAccountProfileDraft,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProfilesArchiveParams {
    pub profile_id: String,
    pub expected_revision: u64,
    pub archived: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_methods_are_finite_and_list_rejects_execution_paths() {
        let valid = serde_json::json!({});
        assert!(serde_json::from_value::<BrowserProfilesListParams>(valid.clone()).is_ok());
        let mut invalid = valid;
        invalid["profilePath"] = serde_json::json!("/other/account");
        assert!(serde_json::from_value::<BrowserProfilesListParams>(invalid).is_err());
        for name in [
            "integrations/browserProfiles/list",
            "integrations/browserProfiles/save",
            "integrations/browserProfiles/setArchived",
        ] {
            assert!(BrowserProfilesMethod::parse(name).is_some());
        }
        assert!(BrowserProfilesMethod::parse("integrations/browserProfiles/execute").is_none());
    }
}
