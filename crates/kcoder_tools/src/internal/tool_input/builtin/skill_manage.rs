use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillManageAction {
    List,
    View,
    Create,
    Edit,
    Patch,
    WriteFile,
    RemoveFile,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SkillManageInput {
    /// Action to perform.
    pub action: SkillManageAction,
    /// Skill name. Required except for `list`.
    #[serde(default)]
    pub name: Option<String>,
    /// Full SKILL.md content. Required for `create` and `edit`.
    #[serde(default)]
    pub content: Option<String>,
    /// Supporting file path under references/, templates/, scripts/, or assets/.
    /// For `patch`, omit this or use SKILL.md to patch the main skill file.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Full supporting file content. Required for `write_file`.
    #[serde(default)]
    pub file_content: Option<String>,
    /// Text to find. Required for `patch`.
    #[serde(default)]
    pub old_string: Option<String>,
    /// Replacement text. Required for `patch`; use an empty string to delete.
    #[serde(default)]
    pub new_string: Option<String>,
    /// Replace all matches for `patch`; otherwise replace exactly one match.
    #[serde(default)]
    pub replace_all: bool,
    /// Revision returned by `view`. Required for race-safe updates; omission is
    /// temporarily accepted for one compatibility release and emits a warning.
    #[serde(default)]
    pub expected_revision: Option<String>,
}

builtin_input!(SkillManageInput);
