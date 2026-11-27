//! Logical committed reads; legacy FileID mappings remain history, not capabilities.
use super::*;
use crate::prepared_immutable::{PreparedImmutableIdentity, observe_committed_unverified};
use kcoder_config::profile_identity::ProfileIdentity;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::SystemTime};

const BINDINGS: &str = "relocation-bindings.json";
const BINDINGS_LIMIT: u64 = 32 * 1024 * 1024;
const MAX_PAYLOADS: usize = 32768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuousWorkRelocationSnapshot {
    profile_identity: String,
    logical_profile_seed: String,
    directory_identity: String,
    header_identity: PortableLeaseIdentity,
    header_sha256: String,
    data_identity: PortableLeaseIdentity,
    data_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    Preparing,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingsReference {
    identity: PortableLeaseIdentity,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelocationReceipt {
    operation_id: String,
    source: ContinuousWorkRelocationSnapshot,
    bindings: BindingsReference,
    stage: Stage,
}

pub(in crate::continuous_work) struct RelocationPayload {
    #[cfg(not(any(target_os = "linux", windows)))]
    pub(in crate::continuous_work) original: Option<PreparedImmutableIdentity>,
    pub(in crate::continuous_work) size: u64,
    pub(in crate::continuous_work) sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadBinding {
    original: PreparedImmutableIdentity,
    target: PreparedImmutableIdentity,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bindings {
    version: u32,
    source_data_sha256: String,
    target_directory: String,
    payloads: BTreeMap<String, PayloadBinding>,
}

#[derive(PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
}

pub(super) struct HeldBindings {
    anchor: File,
    stamp: Stamp,
}

fn stamp(file: &File) -> Result<Stamp> {
    let metadata = file.metadata()?;
    Ok(Stamp {
        size: metadata.len(),
        modified: metadata.modified()?,
        #[cfg(unix)]
        changed: {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        },
    })
}

pub(super) fn valid_header(header: &Header) -> bool {
    match (header.version, &header.relocation) {
        (1 | 2, None) => true,
        (3 | 4, Some(receipt)) => {
            valid_operation(&receipt.operation_id)
                && receipt.source.profile_identity != header.profile
                && receipt.source.directory_identity != header.directory
                && !receipt.source.logical_profile_seed.is_empty()
                && sha(&receipt.source.header_sha256)
                && sha(&receipt.source.data_sha256)
                && sha(&receipt.bindings.sha256)
                && receipt.bindings.size <= BINDINGS_LIMIT
        }
        _ => false,
    }
}

pub(super) fn load_bindings(
    directory: &PrivateDirectory,
    header: &Header,
) -> Result<Option<HeldBindings>> {
    let Some(receipt) = &header.relocation else {
        return Ok(None);
    };
    ensure!(
        valid_header(header) && receipt.stage == Stage::Ready,
        "CONTINUOUS_WORK_RELOCATION_UNCONFIRMED"
    );
    load_reference(directory, &header.directory, receipt).map(Some)
}

fn load_reference(
    directory: &PrivateDirectory,
    target: &str,
    receipt: &RelocationReceipt,
) -> Result<HeldBindings> {
    let anchor = directory.open_single_link_regular_file(OsStr::new(BINDINGS))?;
    let before = stamp(&anchor)?;
    #[cfg(test)]
    BINDING_READS.with(|count| count.set(count.get() + 1));
    let bytes = read_file(directory, BINDINGS, BINDINGS_LIMIT)?;
    ensure!(
        bytes.len() as u64 == receipt.bindings.size
            && digest(&bytes) == receipt.bindings.sha256
            && stamp(&anchor)? == before,
        "CONTINUOUS_WORK_RELOCATION_BINDINGS_CHANGED"
    );
    let value: Bindings = serde_json::from_slice(&bytes)?;
    ensure!(
        value.version == 1
            && value.source_data_sha256 == receipt.source.data_sha256
            && value.target_directory == target
            && value.payloads.len() <= MAX_PAYLOADS,
        "CONTINUOUS_WORK_RELOCATION_BINDINGS_CHANGED"
    );
    for (name, binding) in &value.payloads {
        ensure!(
            name.starts_with("payload-")
                && name.len() <= 160
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && binding.size <= 4 * 1024 * 1024
                && sha(&binding.sha256),
            "CONTINUOUS_WORK_RELOCATION_BINDINGS_CHANGED"
        );
    }
    ensure!(
        directory.portable_regular_identity(OsStr::new(BINDINGS))?
            == directory.portable_regular_handle_identity(&anchor)?,
        "CONTINUOUS_WORK_RELOCATION_BINDINGS_CHANGED"
    );
    Ok(HeldBindings {
        anchor,
        stamp: before,
    })
}

/// Only mapping evidence is retained after its explicit full load. Current
/// business state and source authorization are still read by their owners.
pub(super) fn verify_held_bindings(namespace: &Namespace) -> Result<()> {
    match (&namespace.header.relocation, &namespace.relocation_bindings) {
        (None, None) => Ok(()),
        (Some(receipt), Some(held)) => {
            ensure!(
                receipt.stage == Stage::Ready
                    && ProfileIdentity::observe(&namespace.profile)?.logical_seed()
                        == receipt.source.logical_profile_seed
                    && namespace
                        .directory
                        .portable_regular_identity(OsStr::new(BINDINGS))?
                        == namespace
                            .directory
                            .portable_regular_handle_identity(&held.anchor)?
                    && stamp(&held.anchor)? == held.stamp,
                "CONTINUOUS_WORK_RELOCATION_BINDINGS_CHANGED"
            );
            Ok(())
        }
        _ => anyhow::bail!("CONTINUOUS_WORK_RELOCATION_UNCONFIRMED"),
    }
}

impl Namespace {
    pub(in crate::continuous_work) fn relocation_snapshot(
        &self,
        payloads: impl Fn(&[u8]) -> Result<BTreeMap<String, RelocationPayload>>,
    ) -> Result<ContinuousWorkRelocationSnapshot> {
        let _lease = self.lease(false)?;
        self.snapshot_locked(&payloads)
    }

    fn snapshot_locked(
        &self,
        payloads: &impl Fn(&[u8]) -> Result<BTreeMap<String, RelocationPayload>>,
    ) -> Result<ContinuousWorkRelocationSnapshot> {
        self.verify()?;
        let data = read_file(&self.directory, DATA, DATA_LIMIT)?;
        for (name, payload) in payloads(&data)? {
            #[cfg(any(target_os = "linux", windows))]
            let read = self.observe_committed_payload(&name, payload.size)?;
            #[cfg(any(target_os = "linux", windows))]
            let observed = read.bytes();
            #[cfg(not(any(target_os = "linux", windows)))]
            let bytes = {
                ensure!(
                    payload.original.is_none(),
                    "CONTINUOUS_WORK_RELOCATION_PAYLOAD_PLATFORM_UNSUPPORTED"
                );
                read_file(&self.directory, &name, payload.size)?
            };
            #[cfg(not(any(target_os = "linux", windows)))]
            let observed = bytes.as_slice();
            ensure!(
                observed.len() as u64 == payload.size && digest(observed) == payload.sha256,
                "CONTINUOUS_WORK_PAYLOAD_CHANGED"
            );
        }
        let snapshot = ContinuousWorkRelocationSnapshot {
            profile_identity: self.profile.directory_identity()?,
            logical_profile_seed: ProfileIdentity::observe(&self.profile)?
                .logical_seed()
                .into(),
            directory_identity: self.directory.directory_identity()?,
            header_identity: self.header_identity.clone(),
            header_sha256: digest(&read_file(&self.directory, HEADER, HEADER_LIMIT)?),
            data_identity: self.directory.portable_regular_identity(OsStr::new(DATA))?,
            data_sha256: digest(&data),
        };
        self.verify()?;
        Ok(snapshot)
    }

    pub(in crate::continuous_work) fn relocate(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ContinuousWorkRelocationSnapshot,
        payloads: impl Fn(&[u8]) -> Result<BTreeMap<String, RelocationPayload>>,
        publish: bool,
    ) -> Result<Self> {
        ensure!(
            valid_operation(operation_id),
            "CONTINUOUS_WORK_REQUEST_INVALID"
        );
        let _source_lease = self.lease(true)?;
        ensure!(
            self.snapshot_locked(&payloads)? == *expected,
            "CONTINUOUS_WORK_RELOCATION_SOURCE_CHANGED"
        );
        let profile_path = dunce::canonicalize(final_target_profile)?;
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        profile.verify_config_root_directory()?;
        ensure!(
            profile.directory_identity()? != expected.profile_identity
                && ProfileIdentity::observe(&profile)?.logical_seed()
                    == expected.logical_profile_seed,
            "CONTINUOUS_WORK_RELOCATION_PROFILE_CHANGED"
        );
        let directory = profile
            .open_entry_handle(OsStr::new(DIRECTORY))?
            .open_child_directory()?;
        directory.verify_private_directory()?;
        let (external, lock_name) = self.header.lock_location()?;
        let profile_lock_directory = if external {
            let directory = profile
                .open_entry_handle(OsStr::new(lock_name))?
                .open_child_directory()?;
            directory.verify_private_directory()?;
            Some(directory)
        } else {
            None
        };
        let lock_directory = profile_lock_directory.as_ref().unwrap_or(&directory);
        let lock_anchor = lock_directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let lock_identity = lock_directory.portable_regular_handle_identity(&lock_anchor)?;
        let _target_lease = lock_directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("CONTINUOUS_WORK_BUSY")?;
        let original_header = read_file(&directory, HEADER, HEADER_LIMIT)?;
        let original_header_identity = directory.portable_regular_identity(OsStr::new(HEADER))?;
        let source_header = read_file(&self.directory, HEADER, HEADER_LIMIT)?;
        let source_data = read_file(&self.directory, DATA, DATA_LIMIT)?;
        let target_data_identity = directory.portable_regular_identity(OsStr::new(DATA))?;
        let specifications = payloads(&source_data)?;
        verify_payloads(&directory, &specifications)?;
        ensure!(
            optional_bytes(&directory)? == optional_bytes(&self.directory)?,
            "CONTINUOUS_WORK_RELOCATION_CONFLICT"
        );
        let mut header = self.header.clone();
        header.lock = lock_identity;
        let committed = serde_json::from_slice::<Header>(&original_header)? == header;
        ensure!(
            committed || original_header == source_header,
            "CONTINUOUS_WORK_RELOCATION_CONFLICT"
        );
        ensure!(
            publish || committed,
            "CONTINUOUS_WORK_RELOCATION_UNCONFIRMED"
        );
        let legacy = load_bindings(&directory, &header)?;
        let verify = || -> Result<()> {
            self.verify()?;
            profile.verify_config_root_directory()?;
            ensure!(
                PrivateDirectory::open_existing(&profile_path)?.directory_identity()?
                    == profile.directory_identity()?
                    && profile
                        .open_entry_handle(OsStr::new(DIRECTORY))?
                        .open_child_directory()?
                        .directory_identity()?
                        == directory.directory_identity()?
                    && directory.portable_regular_identity(OsStr::new(DATA))?
                        == target_data_identity
                    && read_file(&self.directory, DATA, DATA_LIMIT)? == source_data
                    && read_file(&directory, DATA, DATA_LIMIT)? == source_data
                    && lock_directory.portable_regular_identity(OsStr::new(LOCK))?
                        == lock_directory.portable_regular_handle_identity(&lock_anchor)?
                    && read_file(lock_directory, LOCK, HEADER_LIMIT)?
                        == read_file(self.lock_directory()?.0, LOCK, HEADER_LIMIT)?,
                "CONTINUOUS_WORK_RELOCATION_DATA_CHANGED"
            );
            if let Some(external) = &profile_lock_directory {
                ensure!(
                    profile
                        .open_entry_handle(OsStr::new(lock_name))?
                        .open_child_directory()?
                        .directory_identity()?
                        == external.directory_identity()?,
                    "CONTINUOUS_WORK_LOCK_DIRECTORY_CHANGED"
                );
            }
            if let Some(held) = &legacy {
                ensure!(
                    directory.portable_regular_identity(OsStr::new(BINDINGS))?
                        == directory.portable_regular_handle_identity(&held.anchor)?
                        && stamp(&held.anchor)? == held.stamp,
                    "CONTINUOUS_WORK_RELOCATION_BINDINGS_CHANGED"
                );
            }
            Ok(())
        };
        verify()?;
        if !committed {
            publish_header(
                &directory,
                &header,
                &original_header,
                &original_header_identity,
                &verify,
            )?;
        }
        verify()?;
        let header_anchor = directory.open_single_link_regular_file(OsStr::new(HEADER))?;
        let header_identity = directory.portable_regular_handle_identity(&header_anchor)?;
        let namespace = Self {
            profile_path,
            profile,
            directory,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
            profile_lock_directory,
            relocation_bindings: legacy,
        };
        namespace.verify()?;
        Ok(namespace)
    }
}

fn verify_payloads(
    directory: &PrivateDirectory,
    payloads: &BTreeMap<String, RelocationPayload>,
) -> Result<()> {
    ensure!(
        payloads.len() <= MAX_PAYLOADS,
        "CONTINUOUS_WORK_RELOCATION_BINDINGS_LIMIT"
    );
    for (name, payload) in payloads {
        #[cfg(any(target_os = "linux", windows))]
        let observed =
            observe_committed_unverified(directory, OsStr::new(name), None, payload.size)?;
        #[cfg(any(target_os = "linux", windows))]
        let bytes = observed.bytes();
        #[cfg(not(any(target_os = "linux", windows)))]
        let owned = read_file(directory, name, payload.size)?;
        #[cfg(not(any(target_os = "linux", windows)))]
        let bytes = owned.as_slice();
        ensure!(
            bytes.len() as u64 == payload.size && digest(bytes) == payload.sha256,
            "CONTINUOUS_WORK_PAYLOAD_CHANGED"
        );
    }
    Ok(())
}

fn publish_header(
    directory: &PrivateDirectory,
    header: &Header,
    expected: &[u8],
    identity: &PortableLeaseIdentity,
    verify: &impl Fn() -> Result<()>,
) -> Result<()> {
    let bytes = serde_json::to_vec(header)?;
    ensure!(
        bytes.len() as u64 <= HEADER_LIMIT,
        "CONTINUOUS_WORK_DATA_LIMIT"
    );
    directory
        .atomic_publish_from_reader(OsStr::new(HEADER), &mut bytes.as_slice(), true, || {
            verify()?;
            ensure!(
                directory.portable_regular_identity(OsStr::new(HEADER))? == *identity
                    && read_file(directory, HEADER, HEADER_LIMIT)? == expected,
                "CONTINUOUS_WORK_RELOCATION_CONFLICT"
            );
            Ok(())
        })
        .context("CONTINUOUS_WORK_RELOCATION_UNCONFIRMED")?;
    Ok(())
}

fn optional_bytes(directory: &PrivateDirectory) -> Result<Option<Vec<u8>>> {
    match read_file(directory, BINDINGS, BINDINGS_LIMIT) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if is_not_found(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}

#[cfg(test)]
thread_local! { static BINDING_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
