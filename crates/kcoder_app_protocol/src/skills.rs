use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillImportParams {
    pub path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRemoveParams {
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManagementResult {
    pub name: String,
    pub applies_to_new_conversations: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillListParams {
    #[serde(default)]
    pub include_disabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogItem {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub enabled: bool,
    pub user_invocable: bool,
    pub can_remove: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListResult {
    pub items: Vec<SkillCatalogItem>,
    pub applies_to_new_conversations: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSetEnabledParams {
    pub name: String,
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSetEnabledResult {
    pub name: String,
    pub enabled: bool,
    pub applies_to_new_conversations: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_contract_defaults_and_rejects_caller_profile_overrides() {
        assert!(
            !serde_json::from_value::<SkillListParams>(serde_json::json!({}))
                .unwrap()
                .include_disabled
        );
        for extra in ["profile", "accountId", "target", "path"] {
            let mut value = serde_json::json!({"name":"known-skill","enabled":false});
            value[extra] = "caller-selected".into();
            assert!(serde_json::from_value::<SkillSetEnabledParams>(value).is_err());
        }
        let receipt = serde_json::to_value(SkillSetEnabledResult {
            name: "known-skill".into(),
            enabled: false,
            applies_to_new_conversations: true,
        })
        .unwrap();
        assert_eq!(
            receipt,
            serde_json::json!({"name":"known-skill","enabled":false,"appliesToNewConversations":true})
        );
    }
}
