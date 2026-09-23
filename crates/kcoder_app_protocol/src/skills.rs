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
