//! Workspace-relative selectors locate files; only native user/PDP/FD checks grant observation.
use super::KnowledgeOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationFileSelectionParams {
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 4096)))]
    pub relative_directory: String,
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 32)))]
    pub file_names: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationFileSelectionItem {
    pub resource_ref: String,
    pub name: String,
    pub identity_revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationFileSelectionReceipt {
    pub owner: KnowledgeOwner,
    pub source_ref: String,
    pub selection_revision: String,
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 32)))]
    pub items: Vec<AutomationFileSelectionItem>,
}
impl AutomationFileSelectionParams {
    pub fn validate(&self) -> Result<(), String> {
        if self.relative_directory.is_empty()
            || self.relative_directory.len() > 4096
            || self.relative_directory.chars().any(char::is_control)
            || self.relative_directory.starts_with('/')
            || self.relative_directory.contains('\\')
            || self.relative_directory.contains(':')
            || (self.relative_directory != "."
                && self
                    .relative_directory
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | "..")))
        {
            return Err("AUTOMATION_FILE_SELECTION_PATH_INVALID".into());
        }
        if self.file_names.is_empty() || self.file_names.len() > 32 {
            return Err("AUTOMATION_FILE_SELECTION_LIMIT".into());
        }
        let mut names = std::collections::BTreeSet::new();
        for name in &self.file_names {
            if name.is_empty()
                || name.len() > 255
                || matches!(name.as_str(), "." | "..")
                || name
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
                || !names.insert(name)
            {
                return Err("AUTOMATION_FILE_SELECTION_NAME_INVALID".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_data_rejects_permission_flags_paths_and_duplicate_names() {
        for directory in [
            "/outside",
            "../outside",
            "a/../outside",
            "a//b",
            "C:\\outside",
        ] {
            assert!(
                AutomationFileSelectionParams {
                    relative_directory: directory.into(),
                    file_names: vec!["one.txt".into()]
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            AutomationFileSelectionParams {
                relative_directory: ".".into(),
                file_names: vec!["one.txt".into(), "one.txt".into()]
            }
            .validate()
            .is_err()
        );
        assert!(
            serde_json::from_value::<AutomationFileSelectionParams>(
                serde_json::json!({"relativeDirectory":".","fileNames":["one.txt"],"trusted":true})
            )
            .is_err()
        );
    }
}
