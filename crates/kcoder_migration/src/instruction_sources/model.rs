//! Private source snapshots and safe structural instruction summaries; no policy authority is imported.
use super::authority::SnapshotRoot;
use anyhow::{Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const MAX_FILES: usize = 128;
pub(super) const MAX_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_DIRECTORIES: usize = 4096;
pub(super) const MAX_ENTRIES: usize = 65_536;
pub(super) const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionRole {
    Shared,
    Local,
    Override,
    Ordinary,
    Fallback,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionTrigger {
    Launch,
    OnRead,
    OnCwd,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionDisposition {
    Selected,
    Empty,
    Shadowed,
    RequiresReview,
}

/// A safe Native projection; the host maps reviewed fields into its shared contract later.
#[derive(Clone)]
pub struct InstructionSourceSummary {
    pub id: String,
    pub relative_path: String,
    pub relative_scope: String,
    pub role: InstructionRole,
    pub trigger: InstructionTrigger,
    pub disposition: InstructionDisposition,
    pub bytes: u64,
    pub reason_code: Option<String>,
}

/// Source configuration must be separately granted before adapting non-default policy.
/// These defaults describe a static known-format view, not env/CLI/managed effective state.
#[derive(Clone)]
pub struct InstructionSourcePolicy {
    pub include_descendants: bool,
    pub codex_fallback_names: Vec<String>,
    pub codex_max_bytes: u64,
    pub codex_root_markers: Vec<String>,
}
impl Default for InstructionSourcePolicy {
    fn default() -> Self {
        Self {
            include_descendants: false,
            codex_fallback_names: Vec::new(),
            codex_max_bytes: 32 * 1024,
            codex_root_markers: vec![".git".into()],
        }
    }
}
impl InstructionSourcePolicy {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            self.codex_fallback_names.len() <= 16
                && self.codex_root_markers.len() <= 16
                && self.codex_max_bytes > 0
                && self.codex_max_bytes <= MAX_BYTES as u64,
            "migration_instruction_policy_unsupported"
        );
        for name in self
            .codex_fallback_names
            .iter()
            .chain(&self.codex_root_markers)
        {
            validate_leaf(name)?;
        }
        let unique = self
            .codex_fallback_names
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        ensure!(
            unique.len() == self.codex_fallback_names.len(),
            "migration_instruction_policy_unsupported"
        );
        Ok(())
    }
}
pub(super) fn validate_leaf(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 256
            && !name.chars().any(char::is_control)
            && !name.contains(['/', '\\', ':'])
            && !matches!(name, "." | ".."),
        "migration_instruction_policy_unsupported"
    );
    let lower = name.to_ascii_lowercase();
    ensure!(
        !lower.starts_with(".env")
            && !lower.ends_with(".pem")
            && !lower.ends_with(".key")
            && !matches!(
                lower.as_str(),
                "auth.json"
                    | "credentials.json"
                    | "credentials.md"
                    | "auth.md"
                    | "id_rsa"
                    | "id_ed25519"
            ),
        "migration_instruction_policy_private_name"
    );
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DirectoryObservation {
    pub relative: String,
    pub identity: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FileObservation {
    pub relative: String,
    pub identity: Option<PortableLeaseIdentity>,
    pub bytes: u64,
    pub sha256: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MarkerObservation {
    pub relative: String,
    pub identity: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EncodedSource {
    pub relative: String,
    pub data: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Candidate {
    pub id: String,
    pub relative_path: String,
    pub relative_scope: String,
    pub role: InstructionRole,
    pub trigger: InstructionTrigger,
    pub disposition: InstructionDisposition,
    pub bytes: u64,
    pub rank: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}
impl Candidate {
    pub(super) fn summary(&self) -> InstructionSourceSummary {
        InstructionSourceSummary {
            id: self.id.clone(),
            relative_path: self.relative_path.clone(),
            relative_scope: self.relative_scope.clone(),
            role: self.role,
            trigger: self.trigger,
            disposition: self.disposition,
            bytes: self.bytes,
            reason_code: self.reason_code.clone(),
        }
    }
}

/// This is a private owned recipe, never an accepted client filesystem binding.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionSourceSnapshot {
    pub(super) version: u32,
    pub(super) root: SnapshotRoot,
    pub(super) directories: BTreeMap<String, DirectoryObservation>,
    pub(super) observations: BTreeMap<String, FileObservation>,
    pub(super) markers: BTreeMap<String, MarkerObservation>,
    pub(super) sources: Vec<EncodedSource>,
    pub(super) candidates: Vec<Candidate>,
    pub(super) complete_launch_chain: bool,
    pub(super) dynamic_scope_present: bool,
}
impl InstructionSourceSnapshot {
    pub(crate) fn is_received_instruction(&self) -> bool {
        self.root.is_received()
    }
    pub(crate) fn verify_consumer(&self, profile: &std::path::Path) -> Result<()> {
        self.root.verify_consumer(profile)
    }
    pub fn format_revision(&self) -> &'static str {
        if self.version == 2 {
            "scoped-instructions/v2"
        } else {
            "scoped-instructions/v1"
        }
    }
    pub fn summaries(&self) -> Vec<InstructionSourceSummary> {
        self.candidates.iter().map(Candidate::summary).collect()
    }
    pub fn complete_launch_chain(&self) -> bool {
        self.complete_launch_chain
    }
    pub fn dynamic_scope_present(&self) -> bool {
        self.dynamic_scope_present
    }
}
