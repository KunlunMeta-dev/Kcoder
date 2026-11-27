//! The v2 initialization is an operation-bound owner receipt, not an allow record.
use super::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Seek, SeekFrom, Write},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelocationBinding {
    pub operation_id: String,
    pub namespace_id: String,
    pub initialization_identity: PortableLeaseIdentity,
    pub source_initialization_identity: PortableLeaseIdentity,
    pub log_initialization_identity: PortableLeaseIdentity,
    pub source_initialization_sha256: String,
    pub source_log_sha256: String,
    pub source_ready: BootstrapEntry,
    pub target_files: BTreeMap<String, PortableLeaseIdentity>,
    // The committed Ready is a separate appended frame. It is never accepted
    // as a field in the preparatory header or inferred from a copied log.
    #[serde(skip)]
    pub ready: Option<BootstrapEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyCommit {
    version: u32,
    operation_id: String,
    initialization_identity: PortableLeaseIdentity,
    ready: BootstrapEntry,
}

pub fn validate_operation(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
        "CONNECTIVITY_RELOCATION_INVALID_OPERATION"
    );
    Ok(())
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn ready_hash(ready: &BootstrapEntry) -> Result<&str> {
    match ready {
        BootstrapEntry::Ready { binding_hash, .. } if valid_digest(binding_hash) => {
            Ok(binding_hash)
        }
        _ => anyhow::bail!("CONNECTIVITY_RELOCATION_ORIGINAL_READY_REQUIRED"),
    }
}

pub fn validate_initialization(
    initial: &Initialization,
    identity: &PortableLeaseIdentity,
) -> Result<()> {
    match (initial.version, &initial.relocation) {
        (1, None) => Ok(()),
        (2, Some(receipt)) => {
            validate_preparation(initial, identity)?;
            let ready = receipt
                .ready
                .as_ref()
                .context("CONNECTIVITY_RELOCATION_READY_UNCONFIRMED")?;
            let BootstrapEntry::Ready {
                namespace_id,
                binding_hash,
                files,
            } = ready
            else {
                anyhow::bail!("CONNECTIVITY_RELOCATION_READY_UNCONFIRMED")
            };
            // A byte-preserved Node binding keeps its hash. The original
            // Native transaction still validates the target files and lease.
            ensure!(
                namespace_id == &receipt.namespace_id
                    && valid_digest(binding_hash)
                    && files == &receipt.target_files,
                "CONNECTIVITY_RELOCATION_READY_UNCONFIRMED"
            );
            Ok(())
        }
        _ => anyhow::bail!("CONNECTIVITY_INITIALIZATION_VERSION_UNSUPPORTED"),
    }
}

fn validate_preparation(initial: &Initialization, identity: &PortableLeaseIdentity) -> Result<()> {
    let receipt = initial
        .relocation
        .as_ref()
        .context("CONNECTIVITY_RELOCATION_RECEIPT_REQUIRED")?;
    validate_operation(&receipt.operation_id)?;
    let BootstrapEntry::Ready { namespace_id, .. } = &receipt.source_ready else {
        anyhow::bail!("CONNECTIVITY_RELOCATION_ORIGINAL_READY_REQUIRED")
    };
    ready_hash(&receipt.source_ready)?;
    ensure!(
        initial.version == 2
            && &receipt.initialization_identity == identity
            && receipt.source_initialization_identity != receipt.initialization_identity
            && namespace_id == &receipt.namespace_id
            && !namespace_id.is_empty()
            && namespace_id.len() <= 256
            && valid_digest(&receipt.source_initialization_sha256)
            && valid_digest(&receipt.source_log_sha256)
            && receipt.target_files.len() == 4
            && ["binding", "ready", "database", "lock"]
                .iter()
                .all(|name| receipt.target_files.contains_key(*name)),
        "CONNECTIVITY_RELOCATION_BINDING_CHANGED"
    );
    Ok(())
}

fn decode(file: &File) -> Result<Initialization> {
    let bytes = read_bytes(file)?;
    let mut frames = serde_json::Deserializer::from_slice(&bytes).into_iter::<serde_json::Value>();
    let mut initial: Initialization = serde_json::from_value(
        frames
            .next()
            .context("CONNECTIVITY_INITIALIZATION_UNCONFIRMED")??,
    )?;
    ensure!(
        initial.version != 2 || bytes.last() == Some(&b'\n'),
        "CONNECTIVITY_RELOCATION_RECEIPT_INVALID"
    );
    let second = frames.next().transpose()?;
    ensure!(
        frames.next().is_none(),
        "CONNECTIVITY_RELOCATION_RECEIPT_INVALID"
    );
    if let Some(frame) = second {
        let commit: ReadyCommit = serde_json::from_value(frame)?;
        let receipt = initial
            .relocation
            .as_mut()
            .context("CONNECTIVITY_RELOCATION_RECEIPT_INVALID")?;
        ensure!(
            initial.version == 2
                && commit.version == 1
                && commit.operation_id == receipt.operation_id
                && commit.initialization_identity == receipt.initialization_identity,
            "CONNECTIVITY_RELOCATION_RECEIPT_INVALID"
        );
        receipt.ready = Some(commit.ready);
    }
    Ok(initial)
}

pub(super) fn read_initialization(file: &File) -> Result<Initialization> {
    let initial = decode(file)?;
    validate_initialization(
        &initial,
        &PortableLeaseIdentity::from_private_regular_handle(file)?,
    )?;
    Ok(initial)
}

/// The owner may inspect its unpublished v2 preparation. Ordinary observation
/// still requires the appended Ready and the original domain's physical receipt.
pub fn read_preparation(file: &File) -> Result<Initialization> {
    let initial = decode(file)?;
    validate_preparation(
        &initial,
        &PortableLeaseIdentity::from_private_regular_handle(file)?,
    )?;
    if initial
        .relocation
        .as_ref()
        .is_some_and(|receipt| receipt.ready.is_some())
    {
        validate_initialization(
            &initial,
            &PortableLeaseIdentity::from_private_regular_handle(file)?,
        )?;
    }
    Ok(initial)
}

pub fn write_preparation(file: &mut File, initial: &Initialization) -> Result<()> {
    ensure!(
        file.metadata()?.len() == 0,
        "CONNECTIVITY_RELOCATION_PREPARATION_EXISTS"
    );
    validate_preparation(
        initial,
        &PortableLeaseIdentity::from_private_regular_handle(file)?,
    )?;
    ensure!(
        initial
            .relocation
            .as_ref()
            .is_some_and(|receipt| receipt.ready.is_none()),
        "CONNECTIVITY_RELOCATION_PREPARATION_INVALID"
    );
    serde_json::to_writer(&mut *file, initial)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

/// Caller holds the original source and final target exclusive owner leases.
/// Unknown or partial frames are never truncated or repaired by this entry.
pub fn append_ready(
    file: &mut File,
    expected: &Initialization,
    ready: BootstrapEntry,
) -> Result<Initialization> {
    let current = read_preparation(file)?;
    let mut planned = current.clone();
    planned.relocation.as_mut().unwrap().ready = None;
    let mut expected_header = expected.clone();
    expected_header
        .relocation
        .as_mut()
        .context("CONNECTIVITY_RELOCATION_RECEIPT_REQUIRED")?
        .ready = None;
    ensure!(
        planned == expected_header,
        "CONNECTIVITY_RELOCATION_OPERATION_CONFLICT"
    );
    if let Some(original) = &current.relocation.as_ref().unwrap().ready {
        ensure!(
            original == &ready,
            "CONNECTIVITY_RELOCATION_OPERATION_CONFLICT"
        );
        return Ok(current);
    }
    let mut committed = expected_header;
    committed.relocation.as_mut().unwrap().ready = Some(ready.clone());
    let identity = PortableLeaseIdentity::from_private_regular_handle(file)?;
    validate_initialization(&committed, &identity)?;
    let receipt = committed.relocation.as_ref().unwrap();
    let commit = ReadyCommit {
        version: 1,
        operation_id: receipt.operation_id.clone(),
        initialization_identity: identity,
        ready,
    };
    file.seek(SeekFrom::End(0))?;
    serde_json::to_writer(&mut *file, &commit)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    ensure!(
        read_preparation(file)? == committed,
        "CONNECTIVITY_RELOCATION_READY_UNCONFIRMED"
    );
    Ok(committed)
}

pub(super) fn project_ready(
    initial: &Initialization,
    identity: &PortableLeaseIdentity,
    bytes: &[u8],
    entries: &mut [BootstrapEntry],
) -> Result<()> {
    validate_initialization(initial, identity)?;
    if let Some(receipt) = &initial.relocation {
        ensure!(
            entries.len() == 3 && digest(bytes) == receipt.source_log_sha256,
            "CONNECTIVITY_RELOCATION_SOURCE_LOG_CHANGED"
        );
        entries[2] = receipt
            .ready
            .as_ref()
            .context("CONNECTIVITY_RELOCATION_READY_UNCONFIRMED")?
            .clone();
    }
    Ok(())
}
