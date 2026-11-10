//! Immutable foreign transcript evidence, independent of active sessions and derived indexes.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::external_history::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub mod attachments;
pub mod branch_views;
pub mod codec;
mod cursor;
mod encoded;
pub mod lifecycle;
pub mod local_attachment;
mod managed;
pub mod projection;
pub mod tool_links;
pub use cursor::ExternalHistoryRecordCursor;
mod publication;
mod stream;
use publication::publish_archive_file;
use stream::{ControlledReader, ENTRY_BYTES, Fingerprint, HashingReader, RecordIndexReader};

const METADATA_BYTES: u64 = 64 * 1024;
const CHUNK_TABLE_BYTES: u64 =
    EXTERNAL_HISTORY_MAX_BYTES.div_ceil(EXTERNAL_HISTORY_CHUNK_BYTES as u64) * 32;
const RAW: &str = "source.bin";
const RAW_CHUNKS: &str = "source-chunks.bin";
const INDEX: &str = "records.bin";
const INDEX_CHUNKS: &str = "record-chunks.bin";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    snapshot_sha256: String,
    archive_id: String,
    session_id: String,
    owner_operation_id: String,
    snapshot: ExternalHistorySnapshot,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    snapshot_sha256: String,
    archive_id: String,
    session_id: String,
    directory_identity: String,
    owns_archive: bool,
    staging_name: Option<String>,
}

pub struct ExternalHistoryStore {
    directory: PrivateDirectory,
}

pub struct ExternalHistoryReader {
    directory: PrivateDirectory,
    binding: Binding,
    lifecycle: lifecycle::ArchiveReadGuard,
}

/// A sequential committed-record view with one verified source block in memory.
pub struct ExternalHistoryRecordReader {
    _lifecycle: lifecycle::ArchiveReadGuard,
    source: File,
    hashes: Vec<u8>,
    total: u64,
    cursor: u64,
    end: u64,
    block: Vec<u8>,
    cached_block: Option<u64>,
}

impl Read for ExternalHistoryRecordReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() || self.cursor == self.end {
            return Ok(0);
        }
        let block_id = self.cursor / EXTERNAL_HISTORY_CHUNK_BYTES as u64;
        let start = block_id * EXTERNAL_HISTORY_CHUNK_BYTES as u64;
        let bytes = (self.total - start).min(EXTERNAL_HISTORY_CHUNK_BYTES as u64) as usize;
        if self.cached_block != Some(block_id) {
            if self.source.metadata()?.len() != self.total {
                return Err(std::io::Error::other(
                    "external_history_stored_content_changed",
                ));
            }
            self.source.seek(SeekFrom::Start(start))?;
            self.source.read_exact(&mut self.block[..bytes])?;
            if Sha256::digest(&self.block[..bytes]).as_slice()
                != &self.hashes[block_id as usize * 32..(block_id as usize + 1) * 32]
            {
                return Err(std::io::Error::other("external_history_chunk_changed"));
            }
            self.cached_block = Some(block_id);
        }
        let offset = (self.cursor - start) as usize;
        let count = output
            .len()
            .min(64 * 1024)
            .min(bytes - offset)
            .min((self.end - self.cursor) as usize);
        output[..count].copy_from_slice(&self.block[offset..offset + count]);
        self.cursor += count as u64;
        Ok(count)
    }
}

pub struct ExternalHistoryImport {
    reader: ExternalHistoryReader,
    owns_archive: bool,
    _lease: File,
    managed: Option<managed::ManagedImport>,
}

pub struct ExternalHistoryCommit {
    pub receipt: ExternalHistoryReceipt,
    /// Reuse does not acquire the original operation's right to remove an archive.
    /// This is an observation, not a capability accepted by a destructive API.
    pub owns_archive: bool,
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_optional(
    directory: &PrivateDirectory,
    name: &str,
    maximum: u64,
) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(_) => anyhow::bail!("external_history_unsafe_file"),
    };
    ensure!(
        file.metadata()?.len() <= maximum,
        "external_history_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= maximum,
        "external_history_metadata_budget_exceeded"
    );
    Ok(Some(bytes))
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("external_history_invalid_metadata"))
}

fn publish_exact(
    directory: &PrivateDirectory,
    name: &str,
    bytes: &[u8],
    maximum: u64,
) -> Result<()> {
    ensure!(
        bytes.len() as u64 <= maximum,
        "external_history_metadata_budget_exceeded"
    );
    if let Some(existing) = read_optional(directory, name, maximum)? {
        ensure!(existing == bytes, "external_history_stored_content_changed");
    } else {
        publish_archive_file(directory, OsStr::new(name), &mut &*bytes)?;
    }
    Ok(())
}

fn validate_snapshot(snapshot: &ExternalHistorySnapshot) -> Result<()> {
    ensure!(
        snapshot.source_bytes <= EXTERNAL_HISTORY_MAX_BYTES
            && (1..=EXTERNAL_HISTORY_MAX_RECORDS).contains(&snapshot.record_limit)
            && valid_hash(&snapshot.source_sha256),
        "external_history_invalid_budget_or_digest"
    );
    for field in [
        &snapshot.origin.source_instance,
        &snapshot.origin.source_session_id,
        &snapshot.origin.source_format,
        &snapshot.origin.adapter_revision,
    ] {
        ensure!(
            !field.is_empty() && field.len() <= 4096,
            "external_history_invalid_origin"
        );
    }
    if let Some(id) = &snapshot.origin.source_artifact_id {
        ensure!(
            !id.is_empty() && id.len() <= 4096,
            "external_history_invalid_origin"
        );
    }
    if let Some(original) = &snapshot.original {
        ensure!(
            original.bytes > 0
                && original.bytes <= EXTERNAL_HISTORY_MAX_BYTES
                && valid_hash(&original.sha256),
            "external_history_invalid_original_source"
        );
    }
    ensure!(
        serde_json::to_vec(snapshot)?.len() as u64 <= METADATA_BYTES / 2,
        "external_history_origin_budget_exceeded"
    );
    Ok(())
}

fn valid_archive(id: &str) -> bool {
    id.strip_prefix("archive-").is_some_and(valid_hash)
}

fn validate_binding(binding: &Binding, id: &str) -> Result<()> {
    validate_snapshot(&binding.snapshot)?;
    let digest = hash(&serde_json::to_vec(&binding.snapshot)?);
    let valid_identity = match (binding.version, binding.generation.as_deref()) {
        (1, None) => id == format!("archive-{digest}"),
        (2, Some(generation))
            if uuid::Uuid::parse_str(generation)
                .is_ok_and(|parsed| parsed.to_string() == generation) =>
        {
            id == format!(
                "archive-{}",
                hash(&serde_json::to_vec(&(
                    "managed-archive/v2",
                    &digest,
                    generation
                ))?)
            )
        }
        _ => false,
    };
    ensure!(
        valid_identity
            && binding.archive_id == id
            && binding.snapshot_sha256 == digest
            && !binding.session_id.is_empty()
            && binding.session_id.len() <= 128
            && binding
                .session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            && !binding.owner_operation_id.is_empty()
            && binding.owner_operation_id.len() <= 128
            && binding
                .owner_operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "external_history_binding_changed"
    );
    Ok(())
}

impl ExternalHistoryStore {
    pub fn archive_id_for_snapshot(snapshot: &ExternalHistorySnapshot) -> Result<String> {
        validate_snapshot(snapshot)?;
        Ok(format!("archive-{}", hash(&serde_json::to_vec(snapshot)?)))
    }

    /// A runtime owner binding. Equal source bytes copied to another profile do not
    /// authorize that profile to consume an earlier selection's handles.
    pub fn scope_fingerprint(&self) -> Result<String> {
        self.directory.verify_private_directory()?;
        Ok(hash(&serde_json::to_vec(&(
            "external-history-owner/v1",
            self.directory.directory_identity()?,
        ))?))
    }
    /// Inspect an existing archive store without creating directories or changing permissions.
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        let parent = match PrivateDirectory::open_existing(profile) {
            Ok(parent) => parent,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        parent.verify_trusted_config_directory()?;
        let directory = match parent.open_child(OsStr::new("external-history"), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(Some(Self { directory }))
    }

    /// The caller supplies the explicitly selected target account/profile, never a source home.
    pub fn open(profile: &Path) -> Result<Self> {
        let parent = PrivateDirectory::open_existing(profile)?;
        parent.verify_trusted_config_directory()?;
        let directory = parent.open_child(OsStr::new("external-history"), true)?;
        directory.verify_private_directory()?;
        Ok(Self { directory })
    }

    pub fn begin(
        &self,
        operation_id: &str,
        snapshot: &ExternalHistorySnapshot,
    ) -> Result<ExternalHistoryImport> {
        ensure!(
            !operation_id.is_empty()
                && operation_id.len() <= 128
                && operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "external_history_invalid_operation"
        );
        validate_snapshot(snapshot)?;
        let snapshot_sha256 = hash(&serde_json::to_vec(snapshot)?);
        let archive_id = Self::archive_id_for_snapshot(snapshot)?;
        let request_name = format!("request-{}.json", hash(operation_id.as_bytes()));
        let _mutation = self
            .directory
            .try_exclusive_lock(OsStr::new("mutation.lock"))?
            .context("external_history_busy")?;
        let mut request: Option<Request> =
            read_optional(&self.directory, &request_name, METADATA_BYTES)?
                .map(|bytes| decode(&bytes))
                .transpose()?;
        if let Some(request) = &request {
            ensure!(
                request.version == 1
                    && request.snapshot_sha256 == snapshot_sha256
                    && request.archive_id == archive_id,
                "external_history_operation_conflict"
            );
        }
        let existing = match self.directory.open_child(OsStr::new(&archive_id), false) {
            Ok(directory) => Some(directory),
            Err(error) if missing(&error) => None,
            Err(_) => anyhow::bail!("external_history_unsafe_directory"),
        };
        let mut prepared_lease = None;
        let directory = if let Some(directory) = existing {
            directory
        } else if let Some(request) = &request {
            ensure!(
                request.owns_archive,
                "external_history_stored_content_changed"
            );
            let temporary = request
                .staging_name
                .as_deref()
                .context("external_history_staging_missing")?;
            ensure!(
                temporary
                    .strip_prefix("staging-")
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()),
                "external_history_invalid_staging_identity"
            );
            let directory = self
                .directory
                .open_child(OsStr::new(temporary), false)
                .map_err(|_| anyhow::anyhow!("external_history_staging_missing"))?;
            directory.verify_private_directory()?;
            ensure!(
                directory.directory_identity()? == request.directory_identity,
                "external_history_staging_changed"
            );
            let binding: Binding = decode(
                &read_optional(&directory, "binding.json", METADATA_BYTES)?
                    .context("external_history_binding_missing")?,
            )?;
            validate_binding(&binding, &archive_id)?;
            ensure!(
                binding.session_id == request.session_id
                    && binding.owner_operation_id == operation_id,
                "external_history_staging_changed"
            );
            prepared_lease = Some(
                directory
                    .try_exclusive_lock(OsStr::new("import.lock"))?
                    .context("external_history_busy")?,
            );
            self.directory
                .rename_no_replace(OsStr::new(temporary), OsStr::new(&archive_id))?;
            directory
        } else {
            // Publish an initialized directory so recovery never adopts a half-written binding.
            let temporary = format!("staging-{}", uuid::Uuid::new_v4());
            let directory = self
                .directory
                .create_private_child(OsStr::new(&temporary))?;
            let binding = Binding {
                version: 1,
                generation: None,
                snapshot_sha256: snapshot_sha256.clone(),
                archive_id: archive_id.clone(),
                session_id: crate::generate_session_id(),
                owner_operation_id: operation_id.to_owned(),
                snapshot: snapshot.clone(),
            };
            directory.atomic_replace(OsStr::new("binding.json"), &serde_json::to_vec(&binding)?)?;
            // Persist the identity of the directory actually created before publication.
            // Matching JSON in a preexisting or copied directory grants no ownership.
            let owned = Request {
                version: 1,
                snapshot_sha256: snapshot_sha256.clone(),
                archive_id: archive_id.clone(),
                session_id: binding.session_id.clone(),
                directory_identity: directory.directory_identity()?,
                owns_archive: true,
                staging_name: Some(temporary.clone()),
            };
            publish_exact(
                &self.directory,
                &request_name,
                &serde_json::to_vec(&owned)?,
                METADATA_BYTES,
            )?;
            request = Some(owned);
            self.directory
                .rename_no_replace(OsStr::new(&temporary), OsStr::new(&archive_id))?;
            directory
        };
        directory.verify_private_directory()?;
        let binding: Binding = decode(
            &read_optional(&directory, "binding.json", METADATA_BYTES)?
                .context("external_history_binding_missing")?,
        )?;
        validate_binding(&binding, &archive_id)?;
        ensure!(
            binding.version == 1
                && binding.archive_id == archive_id
                && binding.snapshot_sha256 == snapshot_sha256
                && binding.snapshot == *snapshot,
            "external_history_binding_changed"
        );
        let owns_archive = request.as_ref().is_some_and(|request| request.owns_archive);
        if let Some(request) = &request {
            ensure!(
                request.directory_identity == directory.directory_identity()?
                    && request.session_id == binding.session_id
                    && (!request.owns_archive || binding.owner_operation_id == operation_id),
                "external_history_stored_content_changed"
            );
        }
        let reader = ExternalHistoryReader {
            directory,
            binding,
            lifecycle: lifecycle::ArchiveReadGuard::legacy(),
        };
        ensure!(
            owns_archive || reader.receipt()?.is_some(),
            "external_history_pending_other_operation"
        );
        let lease = match prepared_lease {
            Some(lease) => lease,
            None => reader
                .directory
                .try_exclusive_lock(OsStr::new("import.lock"))?
                .context("external_history_busy")?,
        };
        let request = request.unwrap_or(Request {
            version: 1,
            snapshot_sha256,
            archive_id,
            session_id: reader.binding.session_id.clone(),
            directory_identity: reader.directory.directory_identity()?,
            owns_archive: false,
            staging_name: None,
        });
        publish_exact(
            &self.directory,
            &request_name,
            &serde_json::to_vec(&request)?,
            METADATA_BYTES,
        )?;
        Ok(ExternalHistoryImport {
            reader,
            owns_archive,
            _lease: lease,
            managed: None,
        })
    }

    /// A read never allocates a session, acquires execution authority, or starts a model.
    pub fn reader(&self, archive_id: &str) -> Result<ExternalHistoryReader> {
        ensure!(
            valid_archive(archive_id),
            "external_history_invalid_archive_id"
        );
        let directory = self.directory.open_child(OsStr::new(archive_id), false)?;
        directory.verify_private_directory()?;
        let binding: Binding = decode(
            &read_optional(&directory, "binding.json", METADATA_BYTES)?
                .context("external_history_binding_missing")?,
        )?;
        validate_binding(&binding, archive_id)?;
        let lifecycle = self.reader_guard(&directory, &binding)?;
        Ok(ExternalHistoryReader {
            directory,
            binding,
            lifecycle,
        })
    }
}

impl ExternalHistoryImport {
    pub fn archive_id(&self) -> &str {
        &self.reader.binding.archive_id
    }
    pub fn session_id(&self) -> &str {
        &self.reader.binding.session_id
    }

    /// The reader must be the caller's selected, pinned snapshot. Unexpected growth, truncation
    /// or content changes fail before atomic publication. Cancellation is checked every 64 KiB.
    pub fn stage_source(
        &mut self,
        source: &mut impl Read,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<()> {
        ensure!(
            self.reader.binding.snapshot.original.is_none(),
            "external_history_encoded_source_requires_decoder"
        );
        self.stage_logical_source(source, ExternalHistoryPhase::Copying, check)
    }

    fn stage_logical_source(
        &mut self,
        source: &mut impl Read,
        phase: ExternalHistoryPhase,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<()> {
        if self.reader.receipt()?.is_some() {
            return self.reader.verify(check);
        }
        ensure!(self.owns_archive, "external_history_reuse_is_read_only");
        let snapshot = &self.reader.binding.snapshot;
        let existing = match self
            .reader
            .directory
            .open_single_link_regular_file(OsStr::new(RAW))
        {
            Ok(file) => Some(file),
            Err(error) if missing(&error) => None,
            Err(_) => anyhow::bail!("external_history_unsafe_file"),
        };
        let fingerprint = if let Some(file) = existing {
            fingerprint(file, snapshot.source_bytes, &snapshot.source_sha256, check)?
        } else {
            ensure!(
                read_optional(&self.reader.directory, RAW_CHUNKS, CHUNK_TABLE_BYTES)?.is_none(),
                "external_history_stored_content_changed"
            );
            let controlled = ControlledReader {
                reader: source,
                check,
                phase,
                total: snapshot.source_bytes,
                processed: 0,
            };
            let mut hashing = HashingReader::new(
                controlled,
                snapshot.source_bytes,
                Some((snapshot.source_bytes, snapshot.source_sha256.clone())),
            );
            publish_archive_file(&self.reader.directory, OsStr::new(RAW), &mut hashing)?;
            hashing.fingerprint()?
        };
        publish_exact(
            &self.reader.directory,
            RAW_CHUNKS,
            &fingerprint.chunks,
            CHUNK_TABLE_BYTES,
        )
    }

    /// Receipt publication is the commit point. A retry can finish from the verified private
    /// source after the original source disappears, without replaying any foreign operation.
    pub fn finish(
        &mut self,
        check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
    ) -> Result<ExternalHistoryCommit> {
        if let Some(receipt) = self.reader.receipt()? {
            self.reader.verify(check)?;
            if let Some(managed) = &self.managed {
                managed.activate(&receipt)?;
            }
            return Ok(ExternalHistoryCommit {
                receipt,
                owns_archive: self.owns_archive,
            });
        }
        ensure!(self.owns_archive, "external_history_reuse_is_read_only");
        let original = self.reader.verify_original(check)?;
        let snapshot = &self.reader.binding.snapshot;
        let source = self
            .reader
            .directory
            .open_single_link_regular_file(OsStr::new(RAW))?;
        let controlled = ControlledReader {
            reader: source,
            check,
            phase: ExternalHistoryPhase::Indexing,
            total: snapshot.source_bytes,
            processed: 0,
        };
        let source = HashingReader::new(
            controlled,
            snapshot.source_bytes,
            Some((snapshot.source_bytes, snapshot.source_sha256.clone())),
        );
        let index = RecordIndexReader::new(source, snapshot.record_limit);
        let mut hashing = HashingReader::new(index, snapshot.record_limit * ENTRY_BYTES, None);
        let existing_index = match self
            .reader
            .directory
            .open_single_link_regular_file(OsStr::new(INDEX))
        {
            Ok(file) => Some(file),
            Err(error) if missing(&error) => None,
            Err(_) => anyhow::bail!("external_history_unsafe_file"),
        };
        if existing_index.is_some() {
            std::io::copy(&mut hashing, &mut std::io::sink())?;
        } else {
            publish_archive_file(&self.reader.directory, OsStr::new(INDEX), &mut hashing)?;
        }
        let index = hashing.fingerprint()?;
        let source = hashing.inner.reader_fingerprint()?;
        let record_count = hashing.inner.count;
        drop(hashing);
        if let Some(file) = existing_index {
            let actual = fingerprint(file, index.bytes, &index.sha256, check)?;
            ensure!(
                actual.chunks == index.chunks,
                "external_history_stored_content_changed"
            );
        }
        publish_exact(
            &self.reader.directory,
            RAW_CHUNKS,
            &source.chunks,
            CHUNK_TABLE_BYTES,
        )?;
        publish_exact(
            &self.reader.directory,
            INDEX_CHUNKS,
            &index.chunks,
            CHUNK_TABLE_BYTES,
        )?;
        let receipt = ExternalHistoryReceipt {
            original,
            schema_version: 1,
            archive_id: self.reader.binding.archive_id.clone(),
            session_id: self.reader.binding.session_id.clone(),
            snapshot_sha256: self.reader.binding.snapshot_sha256.clone(),
            source_bytes: source.bytes,
            source_sha256: source.sha256,
            record_count,
            index_bytes: index.bytes,
            index_sha256: index.sha256,
            source_chunks_sha256: hash(&source.chunks),
            index_chunks_sha256: hash(&index.chunks),
        };
        ensure!(
            check(ExternalHistoryProgress {
                phase: ExternalHistoryPhase::Indexing,
                processed_bytes: snapshot.source_bytes,
                total_bytes: snapshot.source_bytes
            }),
            "external_history_cancelled"
        );
        publish_exact(
            &self.reader.directory,
            "receipt.json",
            &serde_json::to_vec(&receipt)?,
            METADATA_BYTES,
        )?;
        if let Some(managed) = &self.managed {
            managed.activate(&receipt)?;
        }
        Ok(ExternalHistoryCommit {
            receipt,
            owns_archive: true,
        })
    }
}

fn fingerprint(
    source: impl Read,
    bytes: u64,
    sha256: &str,
    check: &mut impl FnMut(ExternalHistoryProgress) -> bool,
) -> Result<Fingerprint> {
    let controlled = ControlledReader {
        reader: source,
        check,
        phase: ExternalHistoryPhase::Verifying,
        total: bytes,
        processed: 0,
    };
    let mut hashing = HashingReader::new(controlled, bytes, Some((bytes, sha256.to_owned())));
    std::io::copy(&mut hashing, &mut std::io::sink())?;
    hashing.fingerprint()
}

impl ExternalHistoryReader {
    pub fn origin(&self) -> &ExternalHistoryOrigin {
        &self.binding.snapshot.origin
    }

    /// Metadata is an observed receipt; reuse and recovery additionally verify all committed bytes.
    pub fn receipt(&self) -> Result<Option<ExternalHistoryReceipt>> {
        let Some(bytes) = read_optional(&self.directory, "receipt.json", METADATA_BYTES)? else {
            return Ok(None);
        };
        let receipt: ExternalHistoryReceipt = decode(&bytes)?;
        ensure!(
            receipt.schema_version == 1
                && receipt.archive_id == self.binding.archive_id
                && receipt.session_id == self.binding.session_id
                && receipt.snapshot_sha256 == self.binding.snapshot_sha256
                && receipt.source_bytes == self.binding.snapshot.source_bytes
                && receipt.source_sha256 == self.binding.snapshot.source_sha256
                && receipt.record_count <= self.binding.snapshot.record_limit
                && receipt.index_bytes == receipt.record_count * ENTRY_BYTES
                && valid_hash(&receipt.index_sha256)
                && valid_hash(&receipt.source_chunks_sha256)
                && valid_hash(&receipt.index_chunks_sha256),
            "external_history_invalid_receipt"
        );
        ensure!(
            receipt.original.as_ref().map(|value| &value.source)
                == self.binding.snapshot.original.as_ref()
                && receipt
                    .original
                    .as_ref()
                    .is_none_or(|value| valid_hash(&value.chunks_sha256)),
            "external_history_invalid_original_receipt"
        );
        Ok(Some(receipt))
    }

    fn verify(&self, check: &mut impl FnMut(ExternalHistoryProgress) -> bool) -> Result<()> {
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        ensure!(
            self.verify_original(check)? == receipt.original,
            "external_history_original_changed"
        );
        for (file, table, bytes, sha256, table_sha) in [
            (
                RAW,
                RAW_CHUNKS,
                receipt.source_bytes,
                &receipt.source_sha256,
                &receipt.source_chunks_sha256,
            ),
            (
                INDEX,
                INDEX_CHUNKS,
                receipt.index_bytes,
                &receipt.index_sha256,
                &receipt.index_chunks_sha256,
            ),
        ] {
            let actual = fingerprint(
                self.directory
                    .open_single_link_regular_file(OsStr::new(file))?,
                bytes,
                sha256,
                check,
            )?;
            let chunks = self.chunk_table(table, table_sha, bytes)?;
            ensure!(
                actual.chunks == chunks,
                "external_history_stored_content_changed"
            );
        }
        Ok(())
    }

    fn chunk_table(&self, name: &str, sha256: &str, total: u64) -> Result<Vec<u8>> {
        let table = read_optional(&self.directory, name, CHUNK_TABLE_BYTES)?
            .context("external_history_chunk_table_missing")?;
        ensure!(
            hash(&table) == sha256
                && table.len() as u64 == total.div_ceil(EXTERNAL_HISTORY_CHUNK_BYTES as u64) * 32,
            "external_history_chunk_table_changed"
        );
        Ok(table)
    }

    fn range(
        &self,
        file: &str,
        table: &str,
        total: u64,
        table_sha: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>> {
        ensure!(
            offset <= total && (1..=EXTERNAL_HISTORY_CHUNK_BYTES).contains(&limit),
            "external_history_invalid_range"
        );
        let table = self.chunk_table(table, table_sha, total)?;
        let source = self
            .directory
            .open_single_link_regular_file(OsStr::new(file))?;
        ensure!(
            source.metadata()?.len() == total,
            "external_history_stored_content_changed"
        );
        let end = total.min(offset + limit as u64);
        let mut result = Vec::with_capacity((end - offset) as usize);
        let mut reader = ExternalHistoryRecordReader {
            _lifecycle: self.lifecycle.clone(),
            source,
            hashes: table,
            total,
            cursor: offset,
            end,
            block: vec![0; EXTERNAL_HISTORY_CHUNK_BYTES],
            cached_block: None,
        };
        reader.read_to_end(&mut result)?;
        Ok(result)
    }

    pub fn records(&self, cursor: u64, limit: u32) -> Result<ExternalHistoryRecordPage> {
        ensure!(
            (1..=EXTERNAL_HISTORY_PAGE_SIZE).contains(&limit),
            "external_history_invalid_page_limit"
        );
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        ensure!(
            cursor <= receipt.record_count,
            "external_history_invalid_cursor"
        );
        let end = receipt.record_count.min(cursor + u64::from(limit));
        let mut records = Vec::new();
        if end > cursor {
            let bytes = self.range(
                INDEX,
                INDEX_CHUNKS,
                receipt.index_bytes,
                &receipt.index_chunks_sha256,
                cursor * ENTRY_BYTES,
                ((end - cursor) * ENTRY_BYTES) as usize,
            )?;
            for (index, entry) in bytes.chunks_exact(ENTRY_BYTES as usize).enumerate() {
                records.push(cursor::decode_entry(
                    entry,
                    cursor + index as u64,
                    receipt.source_bytes,
                )?);
            }
        } else {
            self.range(
                INDEX,
                INDEX_CHUNKS,
                receipt.index_bytes,
                &receipt.index_chunks_sha256,
                cursor * ENTRY_BYTES,
                1,
            )?;
        }
        Ok(ExternalHistoryRecordPage {
            records,
            total_records: receipt.record_count,
            next_cursor: (end < receipt.record_count).then_some(end),
        })
    }

    pub fn read_record_chunk(&self, ordinal: u64, offset: u64, limit: usize) -> Result<Vec<u8>> {
        let page = self.records(ordinal, 1)?;
        let record = page
            .records
            .first()
            .context("external_history_record_not_found")?;
        ensure!(
            offset <= record.bytes && (1..=EXTERNAL_HISTORY_CHUNK_BYTES).contains(&limit),
            "external_history_invalid_range"
        );
        if offset == record.bytes {
            return Ok(Vec::new());
        }
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        self.range(
            RAW,
            RAW_CHUNKS,
            receipt.source_bytes,
            &receipt.source_chunks_sha256,
            record.offset + offset,
            (record.bytes - offset).min(limit as u64) as usize,
        )
    }

    /// Native adapters may stream an authenticated subrange without reading the preceding body.
    pub fn open_record_range(
        &self,
        ordinal: u64,
        offset: u64,
        bytes: u64,
    ) -> Result<ExternalHistoryRecordReader> {
        let mut reader = self.open_record(ordinal)?;
        ensure!(
            offset
                .checked_add(bytes)
                .is_some_and(|end| end <= reader.end - reader.cursor),
            "external_history_invalid_range"
        );
        reader.cursor += offset;
        reader.end = reader.cursor + bytes;
        Ok(reader)
    }

    pub fn open_record(&self, ordinal: u64) -> Result<ExternalHistoryRecordReader> {
        let page = self.records(ordinal, 1)?;
        let record = page
            .records
            .first()
            .context("external_history_record_not_found")?;
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        let hashes = self.chunk_table(
            RAW_CHUNKS,
            &receipt.source_chunks_sha256,
            receipt.source_bytes,
        )?;
        let source = self
            .directory
            .open_single_link_regular_file(OsStr::new(RAW))?;
        ensure!(
            source.metadata()?.len() == receipt.source_bytes,
            "external_history_stored_content_changed"
        );
        Ok(ExternalHistoryRecordReader {
            _lifecycle: self.lifecycle.clone(),
            source,
            hashes,
            total: receipt.source_bytes,
            cursor: record.offset,
            end: record.offset + record.bytes,
            block: vec![0; EXTERNAL_HISTORY_CHUNK_BYTES],
            cached_block: None,
        })
    }
}
