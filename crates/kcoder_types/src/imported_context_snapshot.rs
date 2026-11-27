//! Private native-session context. This is not a user message or a source execution grant.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportedContextSnapshotSource {
    Captured,
    LegacyUnobserved,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedContextSnapshot {
    pub version: u32,
    pub profile_identity: String,
    pub source: ImportedContextSnapshotSource,
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<Box<crate::imported_instructions::ImportedInstructionSession>>,
}

impl std::fmt::Debug for ImportedContextSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportedContextSnapshot")
            .field("version", &self.version)
            .field("source", &self.source)
            .field("has_content", &self.content.is_some())
            .finish_non_exhaustive()
    }
}
