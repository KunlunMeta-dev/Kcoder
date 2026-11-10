//! Immutable preparations for future session publication, never active sessions or tool tasks.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
pub use kcoder_types::historical_context::PreparedContextReceipt;
use kcoder_types::{historical_attachment::*, historical_context::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
mod files;
mod read;
mod sources;
mod stage;
use files::*;
use read::verify_payload;
pub const MAX_CONTEXT_PREPARATIONS: usize = 4096;
pub const MAX_CONTEXT_PREPARATION_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const META: u64 = 128 * 1024;
const MAX_FILES: usize = 2200;

#[derive(Clone, Copy)]
pub struct ContextPreparationProgress {
    pub attachment_index: Option<u32>,
    pub processed_bytes: u64,
}
pub struct PreparedContext {
    pub document: HistoricalContextDocument,
    pub binding: HistoricalContextBinding,
    pub receipt: PreparedContextReceipt,
}
/// Held metadata snapshot; chunk reads do not reparse the full context document.
pub struct PreparedContextReader {
    directory: PrivateDirectory,
    prepared: PreparedContext,
    asset_receipts_sha256: Vec<String>,
    path: PathBuf,
    delivery_names: bool,
    _sources: Vec<crate::external_history::lifecycle::ArchiveReadGuard>,
}
pub struct HistoricalContextStore {
    directory: PrivateDirectory,
    owner: Owner,
    path: PathBuf,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u8,
    profile: String,
    directory: String,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    owner: Owner,
    id: String,
    directory: String,
    document_sha256: String,
    binding_sha256: String,
    #[serde(default, skip_serializing_if = "is_false")]
    delivery_names: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_reference: Option<String>,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Seal {
    version: u8,
    intent_sha256: String,
    asset_receipts_sha256: Vec<String>,
    value: PreparedContextReceipt,
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    version: u8,
    index: u32,
    receipt: HistoricalAttachmentReceipt,
    chunks: Vec<String>,
}

fn check_id(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id),
        "history_context_invalid_preparation_id"
    );
    Ok(())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn progress(
    check: &mut impl FnMut(ContextPreparationProgress) -> bool,
    index: Option<u32>,
    bytes: u64,
) -> Result<()> {
    ensure!(
        check(ContextPreparationProgress {
            attachment_index: index,
            processed_bytes: bytes
        }),
        "history_context_preparation_cancelled"
    );
    Ok(())
}
fn payload(index: u32) -> String {
    format!("attachment-{index:04}.bin")
}
fn is_false(value: &bool) -> bool {
    !*value
}
fn payload_for(index: u32, attachment: &HistoricalContextAttachment, delivery: bool) -> String {
    if !delivery {
        return payload(index);
    }
    let guessed = attachment
        .display_name
        .as_deref()
        .and_then(|name| Path::new(name).extension())
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    let media = attachment
        .media_type
        .as_deref()
        .map(str::to_ascii_lowercase);
    let extension = match media.as_deref() {
        Some("application/pdf") => "pdf",
        Some("text/plain") => "txt",
        Some("text/csv") => "csv",
        Some("application/json") => "json",
        Some("text/markdown") => "md",
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/gif") => "gif",
        Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document") => "docx",
        Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") => "xlsx",
        Some("application/vnd.openxmlformats-officedocument.presentationml.presentation") => "pptx",
        _ => guessed
            .as_deref()
            .filter(|ext| {
                matches!(
                    *ext,
                    "pdf"
                        | "txt"
                        | "csv"
                        | "json"
                        | "md"
                        | "docx"
                        | "xlsx"
                        | "pptx"
                        | "doc"
                        | "xls"
                        | "ppt"
                        | "html"
                        | "svg"
                        | "zip"
                        | "mp3"
                        | "wav"
                        | "png"
                        | "jpg"
                        | "jpeg"
                        | "gif"
                        | "webp"
                )
            })
            .unwrap_or("bin"),
    };
    format!("attachment-{index:04}.{extension}")
}
fn asset(index: u32) -> String {
    format!("attachment-{index:04}.json")
}

impl HistoricalContextStore {
    pub fn open(profile: &Path) -> Result<Self> {
        Self::open_at(profile, true, None)?.context("history_context_store_missing")
    }
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        Self::open_at(profile, false, None)
    }
    fn open_at(profile: &Path, create: bool, expected: Option<&str>) -> Result<Option<Self>> {
        let input_path = profile;
        let profile = match PrivateDirectory::open_existing(profile) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        profile.verify_trusted_config_directory()?;
        ensure!(
            expected.is_none_or(|identity| profile
                .directory_identity()
                .is_ok_and(|actual| actual == identity)),
            "history_context_preparation_target_owner_changed"
        );
        let directory = match profile.open_child(OsStr::new("historical-contexts"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let owner = Owner {
            version: 1,
            profile: profile.directory_identity()?,
            directory: directory.directory_identity()?,
        };
        let profile_path = std::fs::canonicalize(input_path)?;
        ensure!(
            PrivateDirectory::open_existing(&profile_path)?.directory_identity()? == owner.profile,
            "history_context_store_owner_changed"
        );
        if create {
            let _lease = directory
                .try_exclusive_lock(OsStr::new("catalog.lock"))?
                .context("history_context_preparation_busy")?;
            if optional(&directory, "owner.json", META)?.is_none() {
                directory.visit_entry_names_bounded(2, |name| {
                    ensure!(
                        name == OsStr::new("catalog.lock"),
                        "history_context_store_ownership_unknown"
                    );
                    Ok(())
                })?;
                exact(&directory, "owner.json", &serde_json::to_vec(&owner)?)?;
            }
        }
        ensure!(
            read_json::<Owner>(&directory, "owner.json", META)? == owner,
            "history_context_store_owner_changed"
        );
        Ok(Some(Self {
            directory,
            owner,
            path: profile_path.join("historical-contexts"),
        }))
    }
    fn directory(&self, id: &str) -> Result<PrivateDirectory> {
        check_id(id)?;
        let directory = self.directory.open_child(OsStr::new(id), false)?;
        directory.verify_private_directory()?;
        Ok(directory)
    }
    fn intent(&self, directory: &PrivateDirectory, id: &str) -> Result<Intent> {
        let intent: Intent = read_json(directory, "intent.json", META)?;
        ensure!(
            intent.version == 1
                && intent.owner == self.owner
                && intent.id == id
                && intent.directory == directory.directory_identity()?,
            "history_context_preparation_owner_changed"
        );
        if let Some(binding) = &intent.source_reference {
            ensure!(
                *binding
                    == self.fixed_source_binding(
                        &intent.id,
                        &intent.document_sha256,
                        &intent.binding_sha256
                    )?,
                "history_context_preparation_source_changed"
            );
        }
        Ok(intent)
    }
    fn inventory(
        &self,
        check: &mut impl FnMut(ContextPreparationProgress) -> bool,
    ) -> Result<(usize, u64)> {
        let mut count = 0;
        let mut bytes = 0u64;
        self.directory
            .visit_entry_names_bounded(MAX_CONTEXT_PREPARATIONS + 2, |name| {
                progress(check, None, bytes)?;
                if name == OsStr::new("owner.json") || name == OsStr::new("catalog.lock") {
                    self.directory.open_single_link_regular_file(name)?;
                    return Ok(());
                }
                check_id(
                    name.to_str()
                        .context("history_context_unrecognized_preparation")?,
                )?;
                let directory = self.directory.open_child(name, false)?;
                directory.verify_private_directory()?;
                count += 1;
                directory.visit_entry_names_bounded(MAX_FILES, |leaf| {
                    progress(check, None, bytes)?;
                    let file = directory.open_single_link_regular_file(leaf)?;
                    bytes = bytes
                        .checked_add(file.metadata()?.len())
                        .context("history_context_store_budget_exceeded")?;
                    ensure!(
                        bytes <= MAX_CONTEXT_PREPARATION_BYTES,
                        "history_context_store_budget_exceeded"
                    );
                    Ok(())
                })?;
                Ok(())
            })?;
        Ok((count, bytes))
    }
    fn expected(
        document: &HistoricalContextDocument,
        binding: &HistoricalContextBinding,
    ) -> Result<(Vec<u8>, Vec<u8>, u64)> {
        ensure!(
            (1..=HISTORICAL_CONTEXT_MAX_BYTES).contains(&binding.policy.max_context_bytes)
                && (1..=HISTORICAL_CONTEXT_MAX_ENTRIES).contains(&binding.policy.max_entries)
                && binding.policy.max_attachments <= 1024
                && binding.policy.max_attachment_bytes <= 2 * 1024 * 1024 * 1024
                && document.entries.len() <= binding.policy.max_entries as usize
                && document.attachments.len() <= binding.policy.max_attachments as usize
                && document.revision == binding.compiler_revision,
            "history_context_preparation_invalid_document"
        );
        let mut attachment_bytes = 0u64;
        for attachment in &document.attachments {
            let receipt = &attachment.receipt;
            ensure!(
                receipt.bytes <= HISTORICAL_ATTACHMENT_MAX_BYTES
                    && receipt.chunk_bytes as usize == HISTORICAL_ATTACHMENT_CHUNK_BYTES
                    && receipt.sha256.len() == 64
                    && receipt.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "history_context_preparation_invalid_attachment"
            );
            attachment_bytes = attachment_bytes
                .checked_add(receipt.bytes)
                .context("history_context_preparation_attachment_budget_exceeded")?;
        }
        ensure!(
            attachment_bytes <= binding.policy.max_attachment_bytes,
            "history_context_preparation_attachment_budget_exceeded"
        );
        // Serialize through a bounded writer; untrusted native callers cannot force an oversized allocation.
        let body = encoded(document, binding.policy.max_context_bytes)?;
        let proof = encoded(binding, META)?;
        ensure!(
            hash(&body) == binding.document_sha256
                && hash(&encoded_attachments(document)?) == binding.attachments_sha256,
            "history_context_preparation_binding_changed"
        );
        Ok((body, proof, attachment_bytes))
    }
}
fn encoded_attachments(document: &HistoricalContextDocument) -> Result<Vec<u8>> {
    encoded(&document.attachments, HISTORICAL_CONTEXT_MAX_BYTES)
}
