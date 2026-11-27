//! Migration metadata carries provenance and outcomes, never source credentials.
use serde::{Deserialize, Serialize};

/// A source-declared private slot. Values and arbitrary environment lookups are never accepted.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    content = "name",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum MigrationMcpPrivateField {
    Environment(String),
    Header(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
pub enum MigrationSourceKind {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationCredentialPhase {
    Ready,
    Applying,
    Published,
    Undoing,
    Undone,
    Unknown,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationCategory {
    Provider,
    Mcp,
    Skill,
    Command,
    Instructions,
    Memory,
    Plugin,
    Project,
    History,
    Agent,
    Hook,
    Workflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationJobStatus {
    Scanning,
    Ready,
    Applying,
    CancelRequested,
    Cancelled,
    Completed,
    CompletedWithIssues,
    Failed,
    RollingBack,
    RolledBack,
    RollbackConflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationItemStatus {
    Discovered,
    Selected,
    Staged,
    Committing,
    Committed,
    Ready,
    RequiresAction,
    Skipped,
    Failed,
    CommitUnknown,
    RolledBack,
    RollbackConflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationIssueCode {
    UnsupportedSourceFormat,
    UnsupportedField,
    RequiresReauthentication,
    CredentialResolutionRequired,
    SecretExcluded,
    UnsupportedAuthentication,
    MissingModelLimits,
    MissingModel,
    InvalidEndpoint,
    InvalidArguments,
    UnsafePath,
    SourceUnavailable,
    SourceChanged,
    TargetChanged,
    TargetConflict,
    MissingDependency,
    RequiresReview,
    BudgetExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationIssueSeverity {
    Notice,
    Warning,
    Blocking,
}

/// Import blockers prevent publication; activation blockers prevent claiming readiness.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationIssuePhase {
    #[default]
    Import,
    Activation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationIssue {
    pub code: MigrationIssueCode,
    pub severity: MigrationIssueSeverity,
    #[serde(default)]
    pub phase: MigrationIssuePhase,
    /// A reviewed schema field name, not an input value or diagnostic excerpt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl MigrationIssue {
    pub fn blocks_import(&self) -> bool {
        self.severity == MigrationIssueSeverity::Blocking
            && self.phase == MigrationIssuePhase::Import
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationItemPreview {
    pub id: String,
    pub category: MigrationCategory,
    pub source_name: String,
    pub status: MigrationItemStatus,
    pub selected_by_default: bool,
    pub issues: Vec<MigrationIssue>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provenance_and_unknown_outcomes_have_stable_distinct_values() {
        assert_eq!(
            serde_json::to_value(MigrationSourceKind::ClaudeCode).unwrap(),
            "claude-code"
        );
        assert_eq!(
            serde_json::to_value(MigrationItemStatus::CommitUnknown).unwrap(),
            "commit_unknown"
        );
        assert_ne!(
            MigrationItemStatus::CommitUnknown,
            MigrationItemStatus::Failed
        );
        assert_ne!(
            MigrationJobStatus::Completed,
            MigrationJobStatus::CompletedWithIssues
        );
        assert!(
            serde_json::from_str::<MigrationIssue>(
                r#"{"code":"secret_excluded","severity":"notice","secret":"forbidden"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn older_issues_remain_import_blockers_and_activation_is_distinct() {
        let mut issue: MigrationIssue = serde_json::from_str(
            r#"{"code":"credential_resolution_required","severity":"blocking"}"#,
        )
        .unwrap();
        assert!(issue.blocks_import());
        issue.phase = MigrationIssuePhase::Activation;
        assert!(!issue.blocks_import());
    }
}
