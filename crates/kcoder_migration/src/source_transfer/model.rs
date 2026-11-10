use anyhow::{Result, ensure};
use kcoder_types::{external_history::ExternalHistorySnapshot, migration::MigrationSourceKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const TRANSFER_VERSION: u32 = 1;
pub const TRANSFER_CHUNK_BYTES: usize = 128 * 1024;
pub const TRANSFER_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const TRANSFER_MAX_ENTRIES: usize = 1024;
pub const TRANSFER_MAX_STORE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
pub const TRANSFER_MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;

/// Opaque account/instance identities supplied by the authenticated native host, not paths.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferAuthority {
    pub instance_id: String,
    pub account_id: String,
}
impl TransferAuthority {
    pub(super) fn validate(&self) -> Result<()> {
        valid_uuid(&self.instance_id)?;
        ensure!(
            valid_sha(&self.account_id),
            "source_transfer_invalid_authority"
        );
        Ok(())
    }
}

/// Explicit acceptance by one target profile; other accounts cannot adopt the same grant.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferDestination {
    pub grant_id: String,
    pub authority: TransferAuthority,
    pub scope: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum TransferContent {
    ProjectInventory {
        source: MigrationSourceKind,
        format: String,
        #[serde(rename = "sourceIdentity")]
        source_identity: String,
        source_revision: String,
        metadata: kcoder_types::migration_projects::MigrationProjectReceivedMetadata,
    },
    /// Fixed source semantics and raw dependency graph; it contains no filesystem grant.
    InstructionBundle {
        source: MigrationSourceKind,
        parser_revision: String,
    },
    /// Existing adapters' credential-free intermediate form, never raw settings/auth files.
    ConfigurationInventory {
        source: MigrationSourceKind,
        #[serde(rename = "sourceIdentity")]
        source_identity: String,
        source_revision: String,
        source_binding_revision: String,
        source_scope: String,
        adapter_revision: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "uploadedSource"
        )]
        uploaded_source: Option<kcoder_types::migration_source_upload::SourceUploadProvenance>,
    },
    /// Original static package data. Transport readiness is not compatibility or enablement.
    WorkAsset {
        source: MigrationSourceKind,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "sourceIdentity"
        )]
        source_identity: Option<String>,
        category: kcoder_types::migration::MigrationCategory,
        scope: kcoder_config::imported_context::ImportedContextScope,
        asset: String,
        relative: String,
        source_revision: String,
        source_executable: bool,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "memoryProvenance"
        )]
        memory_provenance: Option<Box<kcoder_types::imported_memory::ImportedMemoryProvenance>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "uploadedSource"
        )]
        uploaded_source: Option<kcoder_types::migration_source_upload::SourceUploadProvenance>,
    },
    /// Formal static plugin container; receipt delivery is not installation or enablement.
    PluginPackage {
        origin: Box<crate::plugin_migration::PluginPackageOrigin>,
        format: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "uploadedSource"
        )]
        uploaded_source: Option<kcoder_types::migration_source_upload::SourceUploadProvenance>,
    },
    /// Original physical representation; encoded snapshots retain their original metadata.
    History {
        snapshot: Box<ExternalHistorySnapshot>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "uploadedSource"
        )]
        uploaded_source: Option<kcoder_types::migration_source_upload::SourceUploadProvenance>,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferEntry {
    pub id: String,
    pub bytes: u64,
    pub sha256: String,
    pub content: TransferContent,
}

/// Private manifest. Storage uses opaque IDs; source project labels remain provenance,
/// never destination filesystem authority. Raw authentication files are not payload classes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferManifest {
    pub version: u32,
    pub request_id: String,
    pub source: TransferAuthority,
    pub destination: TransferDestination,
    pub entries: Vec<TransferEntry>,
}
impl TransferManifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == TRANSFER_VERSION,
            "source_transfer_version_unsupported"
        );
        valid_uuid(&self.request_id)?;
        self.source.validate()?;
        self.destination.authority.validate()?;
        valid_uuid(&self.destination.grant_id)?;
        ensure!(
            self.destination.grant_id == self.request_id,
            "source_transfer_request_changed"
        );
        ensure!(
            valid_sha(&self.destination.scope),
            "source_transfer_invalid_destination"
        );
        ensure!(
            !self.entries.is_empty() && self.entries.len() <= TRANSFER_MAX_ENTRIES,
            "source_transfer_budget_exceeded"
        );
        let mut ids = std::collections::BTreeSet::new();
        let mut total = 0u64;
        for entry in &self.entries {
            if let Some(uploaded) = entry.content.uploaded_source() {
                valid_uuid(&uploaded.operation_id)?;
                ensure!(
                    valid_sha(&uploaded.manifest_sha256),
                    "source_transfer_invalid_uploaded_source"
                );
            }
            valid_id(&entry.id)?;
            ensure!(
                ids.insert(&entry.id) && valid_sha(&entry.sha256),
                "source_transfer_invalid_manifest"
            );
            total = total
                .checked_add(entry.bytes)
                .ok_or_else(|| anyhow::anyhow!("source_transfer_budget_exceeded"))?;
            ensure!(
                total <= TRANSFER_MAX_BYTES,
                "source_transfer_budget_exceeded"
            );
            match &entry.content {
                TransferContent::ProjectInventory {
                    source,
                    format,
                    source_identity,
                    source_revision,
                    metadata,
                } => {
                    let revision = match source {
                        MigrationSourceKind::ClaudeCode => "claude-project-registry/json/1",
                        MigrationSourceKind::Codex => "codex-project-registry/sqlite/1",
                    };
                    ensure!(
                        format == crate::project_migration::transfer::PROJECT_TRANSFER_FORMAT
                            && entry.id.ends_with("-0000")
                            && entry.bytes > 0
                            && entry.bytes
                                <= crate::project_migration::transfer::PROJECT_TRANSFER_MAX_BYTES
                            && valid_sha(source_identity)
                            && valid_sha(source_revision)
                            && metadata.format_revision == revision
                            && !metadata.display_name.is_empty()
                            && metadata.display_name.len() <= 4096
                            && !metadata.display_name.chars().any(char::is_control)
                            && metadata.roots <= 16,
                        "source_transfer_project_format_unsupported"
                    );
                }
                TransferContent::InstructionBundle {
                    parser_revision, ..
                } => {
                    ensure!(
                        parser_revision == crate::instruction_sources::portable::GRAPH_PARSER
                            && entry.bytes > 0
                            && entry.bytes
                                <= crate::instruction_sources::portable::MAX_GRAPH_BYTES as u64
                            && entry.id.ends_with("-0000"),
                        "source_transfer_instruction_parser_unsupported"
                    );
                }
                TransferContent::PluginPackage { origin, format, .. } => {
                    origin.validate()?;
                    ensure!(
                        format == kcoder_plugins::migration::PLUGIN_TRANSFER_FORMAT
                            && entry.id.ends_with("-0000"),
                        "source_transfer_plugin_format_unsupported"
                    );
                }
                TransferContent::WorkAsset {
                    asset,
                    relative,
                    category,
                    source_revision,
                    source_identity,
                    source,
                    memory_provenance,
                    ..
                } => {
                    valid_relative(asset)?;
                    valid_relative(relative)?;
                    if matches!(
                        category,
                        kcoder_types::migration::MigrationCategory::Agent
                            | kcoder_types::migration::MigrationCategory::Hook
                    ) {
                        ensure!(
                            entry.bytes <= 4 * 1024 * 1024,
                            "source_transfer_budget_exceeded"
                        );
                    }
                    ensure!(
                        valid_sha(source_revision)
                            && source_identity
                                .as_ref()
                                .is_none_or(|value| valid_sha(value))
                            && matches!(
                                category,
                                kcoder_types::migration::MigrationCategory::Skill
                                    | kcoder_types::migration::MigrationCategory::Command
                                    | kcoder_types::migration::MigrationCategory::Instructions
                                    | kcoder_types::migration::MigrationCategory::Memory
                                    | kcoder_types::migration::MigrationCategory::Agent
                                    | kcoder_types::migration::MigrationCategory::Hook
                            ),
                        "source_transfer_asset_kind_unsupported"
                    );
                    if let Some(origin) = memory_provenance {
                        ensure!(
                            *category == kcoder_types::migration::MigrationCategory::Memory
                                && origin.source == *source
                                && origin.source_file == *asset
                                && origin.source_revision == *source_revision
                                && origin.migration_job_id.is_none()
                                && !origin.facts_verified
                                && !origin.source_group.is_empty()
                                && origin.source_group.len() <= 256
                                && !origin.source_group.chars().any(char::is_control),
                            "source_transfer_memory_provenance_changed"
                        );
                    }
                }
                TransferContent::History { snapshot, .. } => {
                    let physical = snapshot.original.as_ref().map_or(
                        (snapshot.source_bytes, snapshot.source_sha256.as_str()),
                        |original| (original.bytes, original.sha256.as_str()),
                    );
                    ensure!(
                        physical == (entry.bytes, entry.sha256.as_str())
                            && snapshot.source_bytes <= TRANSFER_MAX_BYTES
                            && valid_sha(&snapshot.source_sha256)
                            && snapshot.record_limit > 0
                            && snapshot.record_limit
                                <= kcoder_types::external_history::EXTERNAL_HISTORY_MAX_RECORDS,
                        "source_transfer_invalid_history"
                    );
                }
                TransferContent::ConfigurationInventory {
                    source_identity,
                    source_revision,
                    source_binding_revision,
                    source_scope,
                    adapter_revision,
                    ..
                } => {
                    ensure!(
                        entry.bytes <= 8 * 1024 * 1024,
                        "source_transfer_budget_exceeded"
                    );
                    ensure!(
                        valid_sha(source_identity)
                            && (source_revision
                                .strip_prefix("source-")
                                .is_some_and(valid_sha)
                                || source_scope == "project-effective"
                                    && adapter_revision
                                        == crate::configuration_layers::CLAUDE_LAYERS_REVISION
                                    && source_revision
                                        .strip_prefix("layers-")
                                        .is_some_and(valid_sha)
                                || source_scope == "codex-project-layers"
                                    && adapter_revision
                                        == crate::discovery::codex_layers::CODEX_LAYERS_REVISION
                                    && source_revision
                                        .strip_prefix("codex-layers-")
                                        .is_some_and(valid_sha))
                            && valid_sha(source_binding_revision)
                            && matches!(
                                source_scope.as_str(),
                                "user"
                                    | "user-mcp"
                                    | "project"
                                    | "project-mcp"
                                    | "project-local"
                                    | "project-effective"
                                    | "codex-project-layers"
                            )
                            && !adapter_revision.is_empty()
                            && adapter_revision.len() <= 128,
                        "source_transfer_invalid_configuration_provenance"
                    );
                }
            }
        }
        ensure!(
            serde_json::to_vec(self)?.len() as u64 <= TRANSFER_MANIFEST_MAX_BYTES,
            "source_transfer_budget_exceeded"
        );
        Ok(())
    }
    pub fn digest(&self) -> Result<String> {
        self.validate()?;
        digest(self)
    }
    pub fn total_bytes(&self) -> u64 {
        self.entries
            .iter()
            .fold(0, |total, entry| total.saturating_add(entry.bytes))
    }
}

impl TransferContent {
    pub fn uploaded_source(
        &self,
    ) -> Option<&kcoder_types::migration_source_upload::SourceUploadProvenance> {
        match self {
            Self::InstructionBundle { .. } | Self::ProjectInventory { .. } => None,
            Self::ConfigurationInventory {
                uploaded_source, ..
            }
            | Self::WorkAsset {
                uploaded_source, ..
            }
            | Self::History {
                uploaded_source, ..
            }
            | Self::PluginPackage {
                uploaded_source, ..
            } => uploaded_source.as_ref(),
        }
    }
}

/// No Debug/Serialize implementation: a transport adapter must deliberately handle private bytes.
pub struct TransferChunk {
    pub request_id: String,
    pub manifest_sha256: String,
    pub entry_id: String,
    pub index: u32,
    pub sha256: String,
    pub(super) bytes: Zeroizing<Vec<u8>>,
}
impl TransferChunk {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl TransferChunk {
    /// For a private authenticated transport adapter; payloads must never enter tool logs.
    pub fn received(
        request_id: String,
        manifest_sha256: String,
        entry_id: String,
        index: u32,
        sha256: String,
        bytes: Vec<u8>,
    ) -> Result<Self> {
        valid_uuid(&request_id)?;
        valid_id(&entry_id)?;
        let bytes = Zeroizing::new(bytes);
        ensure!(
            valid_sha(&manifest_sha256)
                && valid_sha(&sha256)
                && !bytes.is_empty()
                && bytes.len() <= TRANSFER_CHUNK_BYTES
                && format!("{:x}", Sha256::digest(&*bytes)) == sha256,
            "source_transfer_invalid_chunk"
        );
        Ok(Self {
            request_id,
            manifest_sha256,
            entry_id,
            index,
            sha256,
            bytes,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferPartReceipt {
    pub manifest_sha256: String,
    pub entry_id: String,
    pub accepted_parts: u32,
    pub accepted_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferReceipt {
    pub request_id: String,
    pub manifest_sha256: String,
    pub entries: u32,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferState {
    pub sequence: u64,
    pub cancel_watermark: u64,
    pub cancelled: bool,
    /// Ready proves validated supplied bytes only, not installed configuration or history.
    pub ready: bool,
}

/// Private static bytes and original scope, not an installed or enabled target asset.
pub struct TransferredWorkAsset {
    pub source: MigrationSourceKind,
    /// Missing on legacy receipts. It must not be reconstructed from a transfer UUID.
    pub source_identity: Option<String>,
    pub category: kcoder_types::migration::MigrationCategory,
    pub source_scope: kcoder_config::imported_context::ImportedContextScope,
    pub source_revision: String,
    pub source_executable_files: Vec<String>,
    /// Files are inert on receipt. Platform/executable mapping requires separate validation.
    pub asset: crate::asset_sources::SourceAsset,
}

pub(super) fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
pub(super) fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(super) fn valid_uuid(value: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value),
        "source_transfer_invalid_request"
    );
    Ok(())
}
pub(super) fn valid_id(value: &str) -> Result<()> {
    ensure!(
        value.len() == 10
            && value.starts_with('e')
            && value.as_bytes()[5] == b'-'
            && value
                .bytes()
                .enumerate()
                .all(|(index, byte)| matches!(index, 0 | 5) || byte.is_ascii_digit()),
        "source_transfer_invalid_entry"
    );
    Ok(())
}
pub(super) fn valid_relative(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 1024 && value.split('/').count() <= 16,
        "source_transfer_unsafe_path"
    );
    for part in value.split('/') {
        ensure!(
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.ends_with(['.', ' '])
                && !part.chars().any(|ch| ch.is_control() || "\\:".contains(ch)),
            "source_transfer_unsafe_path"
        );
        let lower = part.to_ascii_lowercase();
        ensure!(
            !matches!(
                lower.as_str(),
                ".mcp.json"
                    | ".claude.json"
                    | "settings.json"
                    | "settings.local.json"
                    | "settings.jsonc"
                    | "config.toml"
            ),
            "source_transfer_configuration_requires_adapter"
        );
        let stem = lower.split('.').next().unwrap_or("");
        ensure!(
            !matches!(stem, "con" | "prn" | "aux" | "nul")
                && !(stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9')),
            "source_transfer_unsafe_path"
        );
        ensure!(
            !lower.starts_with(".env")
                && !matches!(
                    lower.as_str(),
                    "auth.json"
                        | "auth.toml"
                        | "credentials.json"
                        | "credentials.toml"
                        | ".credentials.json"
                        | "oauth.json"
                        | "oauth_tokens.json"
                        | "token.json"
                        | "tokens.json"
                        | "refresh_token"
                        | "refresh-token"
                        | ".netrc"
                        | ".npmrc"
                        | "cookies"
                        | "cookies.sqlite"
                        | "node_modules"
                        | ".ssh"
                        | ".aws"
                        | ".git"
                        | "id_rsa"
                        | "id_ed25519"
                )
                && !lower.ends_with(".pem")
                && !lower.ends_with(".key"),
            "source_transfer_sensitive_file"
        );
    }
    Ok(())
}

/// Static source provenance only; the destination still requires its own Native grant.
pub(crate) fn configuration_project_scoped(scope: &str) -> bool {
    scope.starts_with("project") || scope == "codex-project-layers"
}
