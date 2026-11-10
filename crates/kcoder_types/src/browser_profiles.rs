//! Browser account metadata is a locator and display context, never a login grant.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum BrowserProfilePurpose {
    Personal,
    Business,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserAccountProfileDraft {
    pub id: String,
    pub label: String,
    /// User-provided label; it is not a verified website identity.
    pub account_label: Option<String>,
    pub purpose: BrowserProfilePurpose,
}
impl BrowserAccountProfileDraft {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err("BROWSER_PROFILE_ID_INVALID");
        }
        for label in [Some(self.label.as_str()), self.account_label.as_deref()]
            .into_iter()
            .flatten()
        {
            if label.trim().is_empty() || label.len() > 256 || label.chars().any(char::is_control) {
                return Err("BROWSER_PROFILE_LABEL_INVALID");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserAccountProfile {
    pub draft: BrowserAccountProfileDraft,
    pub revision: u64,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserAccountProfilePage {
    pub items: Vec<BrowserAccountProfile>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_rejects_execution_paths_and_unbounded_or_invalid_identifiers() {
        let valid = serde_json::json!({"id":"business-1","label":"Office","purpose":"business"});
        let mut draft: BrowserAccountProfileDraft = serde_json::from_value(valid.clone()).unwrap();
        assert!(draft.validate().is_ok());
        let mut extra = valid;
        extra["profilePath"] = serde_json::json!("/user/browser");
        assert!(serde_json::from_value::<BrowserAccountProfileDraft>(extra).is_err());
        for id in [
            "../other".to_owned(),
            String::new(),
            "a".repeat(65),
            "a:b".to_owned(),
        ] {
            draft.id = id;
            assert!(draft.validate().is_err());
        }
        draft.id = "valid".into();
        draft.account_label = Some("label\nsecond line".into());
        assert!(draft.validate().is_err());
        draft.account_label = Some("a".repeat(257));
        assert!(draft.validate().is_err());
    }
}
